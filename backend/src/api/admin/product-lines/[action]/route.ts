import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  updateProductCategoriesWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows"
import { sendFeedNotification } from "../../../../lib/feed-notification"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"
import {
  AUDIT_SETTING_KEY,
  BRANCHES,
  BranchKey,
  ProductLineAuditEntry,
  REASON_CODE_IDS,
  ReasonCode,
  allHandlesForBranch,
} from "../../../../lib/product-lines"

/**
 * POST /admin/product-lines/retire
 * POST /admin/product-lines/reactivate
 *
 * Body: { branch: BranchKey, reason: ReasonCode, notes?: string }
 *
 * RETIRE
 *   1. Look up every category in the branch (intermediate + tier children)
 *   2. Deactivate them (`is_active: false`)
 *   3. Find every currently-published product in that subtree
 *   4. Bulk update `status: "draft"` on those products
 *   5. Append an audit entry with the productIds we touched — reactivate
 *      uses this to re-publish ONLY those (not products added later).
 *   6. Fire an admin bell notification.
 *
 * REACTIVATE
 *   1. Look up the most recent retire audit entry for the branch
 *   2. Reactivate categories from THAT entry (in case new tier cats
 *      were added after retire and shouldn't auto-activate)
 *   3. Bulk update `status: "published"` on the productIds captured
 *      in the retire entry (skips products deleted or archived since)
 *   4. Append a reactivate audit entry
 *   5. Fire an admin bell notification.
 *
 * All state changes are logged before the notification fires — if the
 * bell dispatch throws, the retire/reactivate still succeeded.
 */

type CategoryRow = {
  id: string
  handle?: string | null
  is_active?: boolean | null
  parent_category_id?: string | null
}
type ProductRow = { id: string; status?: string | null; categories?: Array<{ handle?: string | null }> | null }
type Body = { branch?: string; reason?: string; notes?: string }

function isBranchKey(v: string): v is BranchKey {
  return v === "thc-a" || v === "thc-p" || v === "cbd" || v === "cbg"
}
function isReasonCode(v: string): v is ReasonCode {
  return (REASON_CODE_IDS as readonly string[]).includes(v)
}

/* Actor resolution — Medusa v2 exposes the admin user id via
 * req.auth_context.actor_id on admin-scoped routes. Fall back to
 * "unknown_admin" if the auth middleware didn't populate it for any
 * reason (e.g. a future auth swap that changes the shape) — the
 * audit entry still lands, just without attribution. */
function resolveActor(req: MedusaRequest): string {
  const ctx = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context
  return ctx?.actor_id ?? "unknown_admin"
}

function makeAuditId(): string {
  if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
    return (crypto as any).randomUUID()
  }
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)

  const rawAction = String(req.params.action ?? "").toLowerCase()
  if (rawAction !== "retire" && rawAction !== "reactivate") {
    return res.status(400).json({
      ok: false,
      message: `Unknown action "${rawAction}" — must be "retire" or "reactivate".`,
    })
  }
  const action = rawAction as "retire" | "reactivate"

  const body = (req.body ?? {}) as Body
  const branchRaw = String(body.branch ?? "").trim().toLowerCase()
  const reasonRaw = String(body.reason ?? "").trim().toLowerCase()
  if (!isBranchKey(branchRaw)) {
    return res.status(400).json({
      ok: false,
      message: `Unknown branch "${branchRaw}" — must be one of ${Object.keys(BRANCHES).join(", ")}.`,
    })
  }
  if (!isReasonCode(reasonRaw)) {
    return res.status(400).json({
      ok: false,
      message: `Unknown reason "${reasonRaw}" — must be one of ${REASON_CODE_IDS.join(", ")}.`,
    })
  }
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : undefined

  const branch = branchRaw
  const reason = reasonRaw
  const def = BRANCHES[branch]
  const actor = resolveActor(req)
  const handles = allHandlesForBranch(branch)

  /* Pull every category we need + every product in the branch subtree.
   * One graph read each; small enough at production scale. */
  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "handle", "is_active"],
  })
  const catsByHandle = new Map<string, CategoryRow>()
  for (const c of (allCats as CategoryRow[])) {
    if (c.handle) catsByHandle.set(c.handle, c)
  }
  const foundCats = handles
    .map((h) => catsByHandle.get(h))
    .filter((c): c is CategoryRow => !!c)

  if (foundCats.length === 0) {
    return res.status(404).json({
      ok: false,
      message: `None of the ${branch} branch categories (${handles.join(", ")}) exist. Seed them first.`,
    })
  }

  const auditLog = ((await settings.getSetting(AUDIT_SETTING_KEY, [])) ?? []) as ProductLineAuditEntry[]

  try {
    if (action === "retire") {
      /* --- Step 1: deactivate categories --- */
      const nextActive = false
      /* Only touch categories currently in the "other" state — avoids
       * a noop write that would clutter Medusa's category-events feed. */
      const toToggle = foundCats.filter((c) => c.is_active !== nextActive)
      for (const c of toToggle) {
        await updateProductCategoriesWorkflow(req.scope).run({
          input: {
            selector: { id: c.id },
            update: { is_active: nextActive },
          },
        })
      }

      /* --- Step 2: find + unpublish every currently-published product --- */
      const { data: allProducts } = await query.graph({
        entity: "product",
        fields: ["id", "status", "categories.handle"],
      })
      const inBranchPublished = (allProducts as ProductRow[]).filter(
        (p) =>
          p.status === "published"
          && (p.categories ?? []).some((c) => c.handle && handles.includes(c.handle)),
      )
      const productIds = inBranchPublished.map((p) => p.id)

      let productsUpdated = 0
      if (productIds.length > 0) {
        await updateProductsWorkflow(req.scope).run({
          input: {
            selector: { id: productIds },
            update: { status: "draft" },
          },
        })
        productsUpdated = productIds.length
      }

      /* --- Step 3: write audit --- */
      const entry: ProductLineAuditEntry = {
        id: makeAuditId(),
        timestamp: new Date().toISOString(),
        actor,
        action: "retire",
        branch,
        reason,
        notes,
        categoryIds: foundCats.map((c) => c.id),
        productIds,
        categoriesToggled: toToggle.length,
        productsUpdated,
      }
      await settings.setSetting(AUDIT_SETTING_KEY, [...auditLog, entry])

      /* --- Step 4: admin bell --- */
      await sendFeedNotification(req.scope, {
        title: `${def.displayName} retired`,
        description: `${actor} · reason: ${reason} · ${productsUpdated} products unpublished, ${toToggle.length} categories deactivated${notes ? ` · notes: ${notes}` : ""}`,
      })

      logger.info(`[product-lines] retire ${branch} by ${actor} (${reason}) — ${productsUpdated} products, ${toToggle.length} cats`)
      return res.json({
        ok: true,
        action: "retire",
        branch,
        summary: {
          categoriesToggled: toToggle.length,
          productsUpdated,
        },
        entry,
      })
    }

    /* ─────────────── REACTIVATE ─────────────── */

    /* Find the most-recent retire entry for this branch — we reactivate
     * exactly what was retired, not whatever's currently in the tree.
     * Prevents accidental re-publish of products added-and-drafted for
     * unrelated reasons after the retire. */
    const lastRetire = [...auditLog]
      .reverse()
      .find((e) => e.branch === branch && e.action === "retire")

    if (!lastRetire) {
      return res.status(400).json({
        ok: false,
        message: `No prior retire entry for ${branch}. Nothing to reactivate.`,
      })
    }

    /* --- Step 1: reactivate categories from the retire entry --- */
    const catIdsToReactivate = lastRetire.categoryIds
    let categoriesToggled = 0
    if (catIdsToReactivate.length > 0) {
      /* Re-read current state — skip any already active. */
      const stillInactive = (allCats as CategoryRow[])
        .filter((c) => catIdsToReactivate.includes(c.id) && c.is_active === false)
      for (const c of stillInactive) {
        await updateProductCategoriesWorkflow(req.scope).run({
          input: {
            selector: { id: c.id },
            update: { is_active: true },
          },
        })
      }
      categoriesToggled = stillInactive.length
    }

    /* --- Step 2: re-publish exactly the products the retire drafted.
     * Any that were deleted or explicitly archived since won't match
     * (updateProductsWorkflow silently skips missing ids). */
    let productsUpdated = 0
    if (lastRetire.productIds.length > 0) {
      /* Re-read status — only flip those still in draft (skip any
       * already re-published or archived by hand). */
      const { data: currentProducts } = await query.graph({
        entity: "product",
        fields: ["id", "status"],
        filters: { id: lastRetire.productIds },
      })
      const stillDraft = (currentProducts as ProductRow[])
        .filter((p) => p.status === "draft")
        .map((p) => p.id)
      if (stillDraft.length > 0) {
        await updateProductsWorkflow(req.scope).run({
          input: {
            selector: { id: stillDraft },
            update: { status: "published" },
          },
        })
        productsUpdated = stillDraft.length
      }
    }

    /* --- Step 3: write audit --- */
    const entry: ProductLineAuditEntry = {
      id: makeAuditId(),
      timestamp: new Date().toISOString(),
      actor,
      action: "reactivate",
      branch,
      reason,
      notes,
      categoryIds: lastRetire.categoryIds,
      productIds: lastRetire.productIds,
      categoriesToggled,
      productsUpdated,
    }
    await settings.setSetting(AUDIT_SETTING_KEY, [...auditLog, entry])

    /* --- Step 4: admin bell --- */
    await sendFeedNotification(req.scope, {
      title: `${def.displayName} reactivated`,
      description: `${actor} · reason: ${reason} · ${productsUpdated} products republished, ${categoriesToggled} categories reactivated${notes ? ` · notes: ${notes}` : ""}`,
    })

    logger.info(`[product-lines] reactivate ${branch} by ${actor} (${reason}) — ${productsUpdated} products, ${categoriesToggled} cats`)
    return res.json({
      ok: true,
      action: "reactivate",
      branch,
      summary: {
        categoriesToggled,
        productsUpdated,
      },
      entry,
    })
  } catch (e: any) {
    logger.error(`[product-lines] ${action} ${branch} failed: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Action failed" })
  }
}

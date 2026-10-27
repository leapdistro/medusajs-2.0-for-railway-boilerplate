import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../modules/mbs-settings"
import {
  AUDIT_SETTING_KEY,
  ProductLineAuditEntry,
  loadProductLines,
} from "../../../lib/product-lines"

/**
 * GET /admin/product-lines
 *
 * Powers the /app/product-lines admin dashboard. Lines are the
 * categories directly under each top-level category (lib/product-lines).
 * Returns per-line state (active/retired), category counts, product counts (published
 * vs draft), and the last audit entry so the operator can see who
 * retired or reactivated each branch and when.
 *
 * "Retired" ≠ "inactive category". A branch is considered retired
 * when the LAST audit action for that branch is "retire". Missing
 * intermediate category, deactivated child cats, or zero products
 * are all secondary signals — the audit log is the source of truth.
 * That way a branch whose intermediate was accidentally deactivated
 * outside this system still reads as "active" if no retire has been
 * logged, prompting an alert rather than silent state drift.
 */

type ProductRow = {
  id: string
  status?: string | null
  categories?: Array<{ handle?: string | null }> | null
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)

  const lines = await loadProductLines(query)

  /* Pull every product with category handles + status. Same in-memory
   * pass strategy as /tier-prices/apply — production catalogs run in
   * the low thousands, well within one graph read. */
  const { data: allProducts } = await query.graph({
    entity: "product",
    fields: ["id", "status", "categories.handle"],
  })

  const auditLog = ((await settings.getSetting(AUDIT_SETTING_KEY, [])) ?? []) as ProductLineAuditEntry[]

  const branches = lines.map((def) => {
    const key = def.key
    const handles = def.handles
    const cats = def.categories
    const intermediate = def.line

    const inBranchProducts = (allProducts as ProductRow[]).filter((p) =>
      (p.categories ?? []).some((c) => c.handle && handles.includes(c.handle)),
    )
    const publishedCount = inBranchProducts.filter((p) => p.status === "published").length
    const draftCount = inBranchProducts.filter((p) => p.status === "draft").length
    const archivedCount = inBranchProducts.filter((p) => p.status === "archived").length

    /* Last audit entry for this branch drives the state pill. Newest
     * first, so we can early-return on the first match. */
    const lastEntry = [...auditLog]
      .reverse()
      .find((e) => e.branch === key) ?? null

    const state: "active" | "retired" | "unknown" =
      lastEntry?.action === "retire"
        ? "retired"
        : lastEntry?.action === "reactivate"
          ? "active"
          : /* No audit history — infer from category state. Inactive
             * line WITHOUT an audit entry = state drift (operator
             * deactivated in Medusa admin bypassing this flow — flag
             * as "unknown" so ops can investigate). */
            intermediate.is_active === false
                ? "unknown"
                : "active"

    return {
      key,
      displayName: def.displayName,
      state,
      counts: {
        categoriesConfigured: handles.length,
        categoriesFound: cats.length,
        categoriesActive: cats.filter((c) => c.is_active !== false).length,
        productsPublished: publishedCount,
        productsDraft: draftCount,
        productsArchived: archivedCount,
      },
      lastAction: lastEntry
        ? {
            action: lastEntry.action,
            actor: lastEntry.actor,
            reason: lastEntry.reason,
            timestamp: lastEntry.timestamp,
          }
        : null,
    }
  })

  /* Audit log tail — most recent 20 entries. Operator can dig deeper
   * via Medusa admin's raw settings viewer if a longer history is
   * needed (all entries stay in the JSON blob). */
  const recentAudit = [...auditLog].reverse().slice(0, 20)

  res.json({
    ok: true,
    branches,
    recentAudit,
  })
}

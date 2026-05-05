import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Phase 5 — strip the `<tier>-` prefix from existing product handles.
 *
 * Receiving used to generate handles as `${row.tier}-${strainSlug}`
 * (e.g., `exotic-blue-dream`). Phase 5 storefront URL refactor moves
 * the tier into the URL path (`/products/flower/exotic/blue-dream`),
 * so the handle is now just `blue-dream`. This script renames every
 * product currently carrying one of the 5 tier prefixes.
 *
 * Collisions: if two products share a strain across tiers (e.g.,
 * `exotic-blue-dream` AND `super-blue-dream`), the second rename
 * would conflict with the first. The script reports collisions
 * upfront and skips them — operator must rename one manually before
 * re-running.
 *
 * SAFETY: dry-run by default. Pass APPLY=1 to actually rename.
 *
 * Usage:
 *   pnpm exec medusa exec ./src/scripts/migrate-handles-drop-tier.ts
 *   APPLY=1 pnpm exec medusa exec ./src/scripts/migrate-handles-drop-tier.ts
 */

const TIER_PREFIXES = ["classic-", "exotic-", "super-", "snow-", "rapper-"]

function strippedHandle(handle: string): string | null {
  for (const prefix of TIER_PREFIXES) {
    if (handle.startsWith(prefix)) return handle.slice(prefix.length)
  }
  return null
}

export default async function migrateHandlesDropTier({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const apply = process.env.APPLY === "1"

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title"],
  })

  type Plan = { id: string; oldHandle: string; newHandle: string; title: string }
  const plans: Plan[] = []
  const skipped: { id: string; handle: string; title: string; reason: string }[] = []

  for (const p of products) {
    const newHandle = strippedHandle(p.handle)
    if (!newHandle) continue
    plans.push({ id: p.id, oldHandle: p.handle, newHandle, title: p.title })
  }

  /* Collision check — both against existing non-prefixed handles AND
   * against pending renames in this batch. */
  const existingHandles = new Set(products.map((p: any) => p.handle as string))
  const seenNew = new Set<string>()
  const safe: Plan[] = []
  for (const plan of plans) {
    /* If the new handle already exists on a DIFFERENT product, skip. */
    const collision = products.find((p: any) => p.handle === plan.newHandle && p.id !== plan.id)
    if (collision) {
      skipped.push({
        id: plan.id,
        handle: plan.oldHandle,
        title: plan.title,
        reason: `would collide with existing product "${collision.title}" (${collision.handle})`,
      })
      continue
    }
    if (seenNew.has(plan.newHandle)) {
      skipped.push({
        id: plan.id,
        handle: plan.oldHandle,
        title: plan.title,
        reason: `would collide with another rename in this batch (${plan.newHandle})`,
      })
      continue
    }
    seenNew.add(plan.newHandle)
    safe.push(plan)
  }

  logger.info(`Found ${products.length} products total.`)
  logger.info(`Tier-prefixed handles to rename: ${plans.length}`)
  logger.info(`Safe to rename: ${safe.length}`)
  logger.info(`Skipped (collisions): ${skipped.length}`)

  if (safe.length > 0) {
    logger.info("--- Renames ---")
    for (const p of safe) {
      logger.info(`  ${p.oldHandle}  →  ${p.newHandle}    (${p.title})`)
    }
  }

  if (skipped.length > 0) {
    logger.warn("--- Skipped ---")
    for (const s of skipped) {
      logger.warn(`  ${s.handle}    ${s.title}    REASON: ${s.reason}`)
    }
    logger.warn("Resolve these collisions manually before re-running.")
  }

  if (!apply) {
    logger.info("DRY RUN — no changes applied. Pass APPLY=1 to commit.")
    return
  }

  if (safe.length === 0) {
    logger.info("Nothing to apply.")
    return
  }

  /* Bulk rename via the products workflow — one update per plan. */
  for (const plan of safe) {
    await updateProductsWorkflow(container).run({
      input: {
        selector: { id: plan.id },
        update: { handle: plan.newHandle },
      },
    })
    logger.info(`✓ Renamed ${plan.oldHandle} → ${plan.newHandle}`)
  }

  logger.info(`Done. ${safe.length} renames applied. ${skipped.length} skipped.`)
}

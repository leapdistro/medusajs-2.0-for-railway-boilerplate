import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Wipe receiving-created products that have NO receiving_record entry
 * pointing at them. Happens when a receiving Save succeeded at the
 * product-creation step but the history-write threw silently after.
 * The standard pnpm wipe:receiving can't help in this case because it
 * walks the history records.
 *
 * Heuristic: receiving handles are `<tier>-<strain-slug>` (e.g.,
 * `exotic-night-walker`). Manual products use freeform handles. So we
 * find every product whose handle starts with one of the 5 tier
 * prefixes, then delete it + its inventory items.
 *
 * SAFETY: dry-run by default. Pass APPLY=1 to actually delete.
 *
 * Usage:
 *   pnpm wipe:orphan-receivings              # lists what would delete
 *   APPLY=1 pnpm wipe:orphan-receivings      # actually deletes
 */

const TIER_PREFIXES = ["classic-", "exotic-", "super-", "snow-", "rapper-"]

export default async function wipeOrphanReceivings({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const inventoryService: any = container.resolve(Modules.INVENTORY)

  const apply = process.env.APPLY === "1"

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "variants.inventory_items.inventory.id",
    ],
  })

  const orphans = (products as any[]).filter(
    (p) => TIER_PREFIXES.some((pre) => (p.handle ?? "").startsWith(pre)),
  )

  if (orphans.length === 0) {
    logger.info("No orphan receiving products found.")
    return
  }

  logger.info(`▶ Found ${orphans.length} receiving-prefixed product(s)`)
  for (const p of orphans) {
    logger.info(`  · ${(p.title ?? "(no title)").padEnd(28)} handle=${p.handle}`)
  }

  if (!apply) {
    logger.info("─────────────────────────────────")
    logger.info("DRY RUN — no products deleted.")
    logger.info("Re-run with APPLY=1 to actually delete.")
    return
  }

  logger.warn(`▶ APPLY=1 — deleting ${orphans.length} products + inventory items in 3s. Cancel now if wrong.`)
  await new Promise((r) => setTimeout(r, 3000))

  /* Collect inventory item ids before product delete (cascade may
   * remove the variant→inventory link before we can read it). */
  const inventoryItemIds: string[] = []
  for (const p of orphans) {
    for (const v of p.variants ?? []) {
      for (const inv of v.inventory_items ?? []) {
        const id = inv.inventory?.id
        if (id) inventoryItemIds.push(id)
      }
    }
  }
  /* Dedupe — pool inventory means all 3 variants share one item. */
  const uniqInventoryItemIds = Array.from(new Set(inventoryItemIds))

  /* Delete products via workflow (cascades variants + links). */
  try {
    await deleteProductsWorkflow(container).run({
      input: { ids: orphans.map((p) => p.id) },
    })
    logger.info(`  - deleted ${orphans.length} products`)
  } catch (e: any) {
    logger.error(`  ✗ product delete failed: ${e?.message}`)
    return
  }

  /* Then their inventory items. */
  let invDeleted = 0
  for (const id of uniqInventoryItemIds) {
    try {
      await inventoryService.deleteInventoryItems([id])
      invDeleted += 1
    } catch (e: any) {
      logger.warn(`  ? inventory item ${id}: ${e?.message}`)
    }
  }
  logger.info(`  - deleted ${invDeleted} inventory items (of ${uniqInventoryItemIds.length} candidates)`)

  logger.info("─────────────────────────────────")
  logger.info(`✓ wiped ${orphans.length} orphan receiving products`)
}

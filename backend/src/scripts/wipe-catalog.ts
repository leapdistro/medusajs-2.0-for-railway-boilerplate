import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Wipe the catalog: deletes ALL products (which cascades to their variants),
 * then deletes any orphaned inventory items left behind. Safe to leave
 * categories, region, shipping, customer groups, customers, orders untouched.
 *
 * Why exists: ahead of the Phase 1 inventory model rebuild per
 * MBS-Operations-System.md, the current 12 seeded products + per-variant
 * inventory items need to clear out so the new pool model can be built
 * cleanly. Manual deletion in admin is 12 products × several clicks each;
 * this is one command.
 *
 * Idempotent — re-running on an empty catalog is a no-op.
 *
 * Run via: pnpm wipe:catalog
 */

export default async function wipeCatalog({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const inventoryService: any = container.resolve(Modules.INVENTORY)

  logger.info("▶ Wiping product catalog…")

  // ─── 1. Delete every product ───────────────────────────────────────
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title"],
  })
  if (!products?.length) {
    logger.info("  · no products to delete")
  } else {
    const ids = products.map((p: any) => p.id)
    logger.info(`  · deleting ${ids.length} product(s)…`)
    try {
      await deleteProductsWorkflow(container).run({ input: { ids } })
      logger.info(`  ✓ deleted ${ids.length} product(s) (variants cascade)`)
    } catch (e: any) {
      logger.warn(`  ! delete products failed: ${e?.message}`)
    }
  }

  // ─── 2. Delete orphaned inventory items ───────────────────────────
  // Variants are gone; their linked inventory items become orphans. Pull
  // all inventory items + check which still have variant links via the
  // remote graph. Anything with zero linked variants gets removed.
  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku", "variants.id"],
  })
  const orphans = (inventoryItems ?? []).filter((i: any) => !(i.variants ?? []).length)
  if (!orphans.length) {
    logger.info("  · no orphan inventory items to delete")
  } else {
    const ids = orphans.map((i: any) => i.id)
    logger.info(`  · deleting ${ids.length} orphan inventory item(s)…`)
    try {
      await inventoryService.deleteInventoryItems(ids)
      logger.info(`  ✓ deleted ${ids.length} inventory item(s)`)
    } catch (e: any) {
      logger.warn(`  ! delete inventory items failed: ${e?.message}`)
    }
  }

  logger.info("─────────────────────────────────")
  logger.info("✓ Catalog wipe complete.")
  logger.info("  Untouched: categories, region, shipping, customer groups, customers, orders.")
  logger.info("  Verify in admin → Products (should be empty) and Inventory (should be empty).")
}

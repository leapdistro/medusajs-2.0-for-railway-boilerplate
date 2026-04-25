import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Idempotent inventory bootstrap. For every product variant in the catalog:
 *   1. Flip manage_inventory → true (if not already)
 *   2. Create an inventory_item with the variant's SKU (if not already)
 *   3. Link the variant ↔ inventory_item (if not already)
 *   4. Set initial stock at the MBS US Warehouse (defaults to INITIAL_QTY,
 *      overridden via `--qty=<n>` arg)
 *
 * Existing items + levels are left untouched — re-running just fills in
 * what's missing.
 *
 * Run:  pnpm seed:inventory
 *       pnpm seed:inventory --qty=250    (override default per-variant qty)
 */

const INITIAL_QTY = 100
const WAREHOUSE_NAME = process.env.SEED_INVENTORY_LOCATION_NAME || "MBS US Warehouse"

export default async function seedInventory({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link   = container.resolve(ContainerRegistrationKeys.LINK)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)

  const productService:    any = container.resolve(Modules.PRODUCT)
  const inventoryService:  any = container.resolve(Modules.INVENTORY)
  const stockLocationService: any = container.resolve(Modules.STOCK_LOCATION)

  // Allow `--qty=N` arg to override.
  let qty = INITIAL_QTY
  for (const a of args ?? []) {
    const m = /^--qty=(\d+)$/.exec(a)
    if (m) qty = parseInt(m[1], 10)
  }

  logger.info(`▶ Seeding inventory @ ${qty} units per variant…`)

  // ─── 1. Find the warehouse ─────────────────────────────────────────
  const locations = await stockLocationService.listStockLocations({ name: [WAREHOUSE_NAME] }, { take: 1 })
  const warehouse = locations?.[0]
  if (!warehouse) {
    logger.error(`✗ No stock location named "${WAREHOUSE_NAME}". Run \`pnpm seed:us\` first.`)
    return
  }
  logger.info(`  · warehouse: ${warehouse.name} (${warehouse.id})`)

  // ─── 2. List every variant ─────────────────────────────────────────
  // Pull all variants with their existing inventory items via query.graph so
  // we can detect what's already linked + skip without duplicate work.
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "manage_inventory", "title", "product.title", "inventory_items.inventory.id", "inventory_items.inventory.sku"],
  })
  if (!variants?.length) {
    logger.warn("✗ No product variants found.")
    return
  }
  logger.info(`  · ${variants.length} variant(s) in catalog`)

  // ─── 3. For each variant: flip flag → ensure item → link → set level ──
  let flagFlipped = 0
  let itemsCreated = 0
  let linksCreated = 0
  let levelsSet = 0
  let skipped = 0

  for (const v of variants) {
    if (!v.sku) {
      logger.warn(`  ! variant ${v.id} (${v.product?.title} / ${v.title}) has no SKU — skipping`)
      skipped += 1
      continue
    }

    // 3a. Flip manage_inventory if false
    if (!v.manage_inventory) {
      try {
        await productService.upsertVariants([{ id: v.id, manage_inventory: true }])
        flagFlipped += 1
      } catch (e: any) {
        logger.warn(`  ! flip manage_inventory failed on ${v.sku}: ${e?.message}`)
      }
    }

    // 3b. Resolve / create the inventory item for this SKU
    let inventoryItemId: string | undefined = v.inventory_items?.[0]?.inventory?.id
    if (!inventoryItemId) {
      // Maybe an item with this SKU already exists but isn't linked yet
      const existing = await inventoryService.listInventoryItems({ sku: [v.sku] }, { take: 1 })
      inventoryItemId = existing?.[0]?.id
    }
    if (!inventoryItemId) {
      try {
        const created = await inventoryService.createInventoryItems({
          sku: v.sku,
          title: v.product?.title ? `${v.product.title} · ${v.title}` : v.sku,
        })
        inventoryItemId = Array.isArray(created) ? created[0]?.id : created?.id
        itemsCreated += 1
      } catch (e: any) {
        logger.warn(`  ! create inventory_item failed for ${v.sku}: ${e?.message}`)
        continue
      }
    }
    if (!inventoryItemId) {
      logger.warn(`  ! could not resolve inventory_item id for ${v.sku}`)
      continue
    }

    // 3c. Link variant ↔ inventory_item if not already linked
    const alreadyLinked = (v.inventory_items ?? []).some((i: any) => i?.inventory?.id === inventoryItemId)
    if (!alreadyLinked) {
      try {
        await link.create({
          [Modules.PRODUCT]:   { variant_id: v.id },
          [Modules.INVENTORY]: { inventory_item_id: inventoryItemId },
        })
        linksCreated += 1
      } catch (e: any) {
        // duplicate-link errors mean we're already linked; quiet skip
        if (!String(e?.message ?? "").toLowerCase().includes("duplicate")) {
          logger.warn(`  ! link variant ↔ inventory failed for ${v.sku}: ${e?.message}`)
        }
      }
    }

    // 3d. Ensure an inventory level exists at the warehouse
    const existingLevels = await inventoryService.listInventoryLevels(
      { inventory_item_id: [inventoryItemId], location_id: [warehouse.id] },
      { take: 1 },
    )
    if (!existingLevels?.length) {
      try {
        await inventoryService.createInventoryLevels([{
          inventory_item_id: inventoryItemId,
          location_id: warehouse.id,
          stocked_quantity: qty,
        }])
        levelsSet += 1
      } catch (e: any) {
        logger.warn(`  ! create inventory_level failed for ${v.sku}: ${e?.message}`)
      }
    }
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ flag flipped to manage_inventory: ${flagFlipped}`)
  logger.info(`✓ inventory items created:          ${itemsCreated}`)
  logger.info(`✓ variant ↔ item links created:     ${linksCreated}`)
  logger.info(`✓ initial stock levels set:         ${levelsSet}`)
  if (skipped > 0) logger.info(`! skipped (no SKU):                  ${skipped}`)
  logger.info(`Done. Verify in admin → Inventory.`)
}

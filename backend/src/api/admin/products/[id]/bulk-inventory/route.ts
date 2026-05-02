import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/products/[id]/bulk-inventory
 *
 * Set or increment stocked quantity on every variant of a product at
 * a given stock location. Solves the multi-variant restock pain — for
 * a 6-variant waterpipe the operator clicks once instead of expanding
 * each variant and adding a level individually.
 *
 * Body:
 *   {
 *     locationId: string   // stock location to write to
 *     mode: "set" | "add"  // overwrite vs increment
 *     quantity: number     // the quantity (or delta for "add")
 *   }
 *
 * Behavior:
 *   - For each variant's linked inventory items: ensure a level exists
 *     at locationId; create if missing, then set or increment.
 *   - Pool-inventory products (QP / Half / LB sharing one InventoryItem
 *     via required_quantity 1/2/4) only update the shared pool ONCE —
 *     dedupes by inventory_item_id so we don't multiply the operator's
 *     intent by the variant count.
 *   - Returns per-inventory-item outcome so the widget can report.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as { locationId?: string; mode?: "set" | "add"; quantity?: number }
  const locationId = String(body.locationId ?? "")
  const mode = body.mode === "add" ? "add" : "set"
  const quantity = Number(body.quantity)

  if (!locationId) {
    res.status(400).json({ ok: false, error: "locationId is required" })
    return
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    res.status(400).json({ ok: false, error: "quantity must be a non-negative number" })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const inventoryService: any = req.scope.resolve(Modules.INVENTORY)

  /* Pull all inventory items linked to this product's variants. */
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "variants.id",
      "variants.title",
      "variants.inventory_items.inventory.id",
    ],
    filters: { id },
  })
  const product = products?.[0]
  if (!product) {
    res.status(404).json({ ok: false, error: "Product not found" })
    return
  }

  /* Dedupe inventory item ids — pool products share one item across
   * variants, so we only update the shared pool once. */
  const inventoryItemIds: string[] = []
  for (const v of (product as any).variants ?? []) {
    for (const ii of v.inventory_items ?? []) {
      const id = ii.inventory?.id
      if (id && !inventoryItemIds.includes(id)) inventoryItemIds.push(id)
    }
  }

  if (inventoryItemIds.length === 0) {
    res.status(400).json({
      ok: false,
      error: "Product has no inventory items. Set manage_inventory on its variants first.",
    })
    return
  }

  const results: Array<{ inventoryItemId: string; action: "set" | "added" | "created" | "failed"; before?: number; after?: number; error?: string }> = []

  for (const inventoryItemId of inventoryItemIds) {
    try {
      /* Find existing level at this location, if any. */
      const levels = await inventoryService.listInventoryLevels({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
      })
      const level = levels[0]
      if (!level) {
        /* No level → create one with the desired quantity (in "add"
         * mode the starting value is just `quantity`, since base = 0). */
        await inventoryService.createInventoryLevels([{
          inventory_item_id: inventoryItemId,
          location_id: locationId,
          stocked_quantity: quantity,
        }])
        results.push({ inventoryItemId, action: "created", before: 0, after: quantity })
        continue
      }
      const before = level.stocked_quantity ?? 0
      const after = mode === "set" ? quantity : before + quantity
      await inventoryService.updateInventoryLevels([{
        id: level.id,
        stocked_quantity: after,
      }])
      results.push({ inventoryItemId, action: mode === "set" ? "set" : "added", before, after })
    } catch (e: any) {
      results.push({ inventoryItemId, action: "failed", error: e?.message ?? String(e) })
    }
  }

  const failed = results.filter((r) => r.action === "failed").length
  res.json({
    ok: failed === 0,
    summary: {
      inventoryItemsAffected: results.length,
      failed,
    },
    results,
  })
}

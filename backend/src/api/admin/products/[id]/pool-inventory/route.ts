import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * GET /admin/products/:id/pool-inventory
 *
 * Returns a pool-inventory summary for products whose variants share
 * ONE InventoryItem (the pool model — flower QP/½/LB linked via
 * required_quantity, pre-rolls' single Box variant, anything similar
 * future receiving creates). When the product is NOT a pool, returns
 * { isPool: false } so the widget can hide itself.
 *
 * Pool detection: every variant's inventory_items[0] points at the
 * same inventory_item id. Multi-item variants (regular non-pool
 * products created via Medusa's standard admin) fail the check and
 * skip the widget entirely.
 *
 * Pool size: stocked - reserved on the shared InventoryItem, summed
 * across all of its location_levels (most setups have one location).
 *
 * Per-variant sellable: floor(poolSize / required_quantity). E.g.,
 * a flower product with 8 QPs in the pool can sell 8×QP / 4×½ / 2×LB.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productId = req.params.id
  if (!productId) return res.status(400).json({ error: "missing product id" })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "variants.id",
      "variants.title",
      "variants.sku",
      "variants.inventory_items.required_quantity",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { id: productId },
  })
  const product = (data as any[])[0]
  if (!product) return res.status(404).json({ error: "product not found" })

  const variants = (product.variants ?? []) as Array<{
    id: string
    title: string
    sku: string | null
    inventory_items?: Array<{
      required_quantity?: number
      inventory?: {
        id?: string
        location_levels?: Array<{ stocked_quantity?: number; reserved_quantity?: number }>
      }
    }>
  }>

  /* Pool detection: collect distinct inventory_item ids referenced by
   * any variant. Pool = exactly ONE distinct id, referenced by every
   * variant via inventory_items[0]. */
  const distinctIds = new Set<string>()
  for (const v of variants) {
    for (const ii of v.inventory_items ?? []) {
      const id = ii.inventory?.id
      if (id) distinctIds.add(id)
    }
  }
  if (distinctIds.size !== 1 || variants.length === 0) {
    return res.json({ isPool: false })
  }

  /* All variants reference the same pool. Compute pool size from any
   * one of them (they all point to the same InventoryItem). */
  const sample = variants[0].inventory_items?.[0]?.inventory
  const levels = sample?.location_levels ?? []
  const stocked = levels.reduce((s, lv) => s + Number(lv.stocked_quantity ?? 0), 0)
  const reserved = levels.reduce((s, lv) => s + Number(lv.reserved_quantity ?? 0), 0)
  const available = Math.max(0, stocked - reserved)

  const variantSummaries = variants.map((v) => {
    const required = Number(v.inventory_items?.[0]?.required_quantity ?? 1) || 1
    const sellable = Math.floor(available / required)
    return { id: v.id, title: v.title ?? "", sku: v.sku ?? null, requiredQuantity: required, sellable }
  })

  /* Pool unit label = the variant with required_quantity === 1 (the
   * smallest unit). Flower's "QP" is this; pre-rolls' single Box is too.
   * Fall back to "unit" if no multiplier=1 variant exists. */
  const poolUnitVariant = variantSummaries.find((v) => v.requiredQuantity === 1) ?? variantSummaries[0]
  const poolUnitLabel = poolUnitVariant?.title || "unit"

  return res.json({
    isPool: true,
    poolUnitLabel,
    stocked,
    reserved,
    available,
    variants: variantSummaries,
  })
}

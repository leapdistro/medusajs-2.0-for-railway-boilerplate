import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Custom Store route that returns products with the linked `product_attributes`
 * joined in. Medusa's native /store/products endpoint can't expand custom
 * module links via the `fields` query param (returns 500), so the storefront
 * adapter calls THIS endpoint instead.
 *
 * Optional query params:
 *   - handle: string  → return only the product matching this handle
 *   - status: string  → defaults to "published"; pass "all" to include drafts
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const handle = req.query.handle as string | undefined
  const statusParam = (req.query.status as string | undefined) ?? "published"

  const filters: Record<string, unknown> = {}
  if (handle) filters.handle = handle
  if (statusParam !== "all") filters.status = statusParam

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "title", "handle", "thumbnail", "status",
      "images.*",
      "options.*", "options.values.*",
      "variants.id", "variants.title", "variants.sku", "variants.weight",
      "variants.manage_inventory",
      "variants.options.*", "variants.options.option.title",
      "variants.price_set.prices.amount", "variants.price_set.prices.currency_code",
      /* Pull inventory data so the storefront can render
       * per-variant "X available" labels without a second
       * round-trip. For pool products (Flower QP/½/LB sharing
       * one inventory item via required_quantity), each variant's
       * available is floor(stock / required_quantity). */
      "variants.inventory_items.required_quantity",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
      "categories.id", "categories.name", "categories.handle", "categories.parent_category_id", "categories.metadata",
      "product_attributes.*",
    ],
    filters,
  })

  res.json({ products, count: products.length })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules, QueryContext } from "@medusajs/framework/utils"

/**
 * Custom Store route that returns products with the linked `product_attributes`
 * joined in. Medusa's native /store/products endpoint can't expand custom
 * module links via the `fields` query param (returns 500), so the storefront
 * adapter calls THIS endpoint instead.
 *
 * Optional query params:
 *   - handle: string  → return only product(s) matching this handle.
 *                       Accepts a single value ("blue-dream") or a
 *                       comma-separated list ("blue-dream,og-kush")
 *                       for batch existence/availability lookups
 *                       (used by /account/orders/[id] to determine
 *                       which line items still link to a live PDP).
 *   - status: string  → defaults to "published"; pass "all" to include drafts
 *
 * Customer-group pricing (Distro, Owner Stores) — when called with a
 * customer Bearer token, the route resolves the customer's group
 * memberships and passes them as pricing context to query.graph. Medusa
 * then evaluates any PriceList rules (e.g. `customer.groups.id`) and
 * returns `variants.calculated_price.calculated_amount` reflecting the
 * group-specific price. Public/anonymous callers see default prices.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const handleParam = req.query.handle as string | undefined
  const statusParam = (req.query.status as string | undefined) ?? "published"

  const filters: Record<string, unknown> = {}
  if (handleParam) {
    if (handleParam.includes(",")) {
      const handles = handleParam.split(",").map((s) => s.trim()).filter(Boolean)
      filters.handle = handles
    } else {
      filters.handle = handleParam
    }
  }
  if (statusParam !== "all") filters.status = statusParam

  /* Resolve the authenticated customer (when present) so we can attach
   * a pricing context that Medusa's PriceList rules can evaluate. The
   * `customer.groups.id` attribute is what slice 4's distro PriceList
   * keys off — without it, every caller sees default prices. */
  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  const pricingContext: Record<string, any> = { currency_code: "usd" }
  if (customerId) {
    try {
      const customerService: any = req.scope.resolve(Modules.CUSTOMER)
      const [customer] = await customerService.listCustomers(
        { id: [customerId] },
        { take: 1, relations: ["groups"] },
      )
      const groupIds = ((customer?.groups ?? []) as Array<{ id?: string }>)
        .map((g) => g?.id)
        .filter((id): id is string => Boolean(id))
      if (groupIds.length > 0) {
        pricingContext["customer.groups.id"] = groupIds
      }
    } catch {
      /* Soft-fail: if customer lookup blows up, fall through to
       * default pricing rather than 500ing the catalog. */
    }
  }

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "title", "handle", "thumbnail", "status", "created_at",
      "images.*",
      "options.*", "options.values.*",
      "variants.id", "variants.title", "variants.sku", "variants.weight",
      "variants.metadata",
      "variants.barcode",
      "variants.manage_inventory",
      "variants.options.*", "variants.options.option.title",
      "variants.price_set.prices.amount", "variants.price_set.prices.currency_code",
      /* calculated_price reflects the customer-group-scoped PriceList
       * (Distro / Owner Stores) when a customer context is provided.
       * For anonymous callers it falls back to the default price. */
      "variants.calculated_price.calculated_amount",
      "variants.calculated_price.original_amount",
      "variants.calculated_price.currency_code",
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
    context: {
      variants: {
        calculated_price: QueryContext(pricingContext),
      },
    },
  })

  res.json({ products, count: products.length })
}

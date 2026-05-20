import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * GET /admin/products/:id/reservations-debug
 *
 * TEMPORARY diagnostic — remove after we figure out why TEST PRE-ROLL
 * (and any other product) shows reserved units against cancelled orders.
 * Returns every reservation row tied to the product's variants, plus the
 * line item and order each one came from with the order's current status.
 *
 * Orphaned reservation = row exists, order.status === "canceled". Those
 * are the ones we expected cancelOrderWorkflow to release.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productId = req.params.id
  if (!productId) return res.status(400).json({ error: "missing product id" })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const inventoryService: any = req.scope.resolve(Modules.INVENTORY)

  /* 1. Find the product + its inventory_item ids (variants may share
   *    one inventory_item via the pool model, or have their own). */
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "title", "handle",
      "variants.id", "variants.sku", "variants.title",
      "variants.inventory_items.required_quantity",
      "variants.inventory_items.inventory.id",
    ],
    filters: { id: productId },
  })
  const product = (products as any[])?.[0]
  if (!product) return res.status(404).json({ error: "product not found" })

  const invItemIds = new Set<string>()
  const variants = (product.variants ?? []).map((v: any) => {
    const ids: string[] = []
    for (const ii of v.inventory_items ?? []) {
      if (ii.inventory?.id) {
        invItemIds.add(ii.inventory.id)
        ids.push(ii.inventory.id)
      }
    }
    return {
      id: v.id,
      sku: v.sku ?? null,
      title: v.title ?? null,
      required_quantity: v.inventory_items?.[0]?.required_quantity ?? null,
      inventory_item_ids: ids,
    }
  })

  if (invItemIds.size === 0) {
    return res.json({
      product: { id: product.id, title: product.title, handle: product.handle },
      variants,
      reservations: [],
      note: "no inventory items linked to this product's variants",
    })
  }

  /* 2. List reservation rows for those inventory items. */
  const reservationRows: any[] = await inventoryService.listReservationItems(
    { inventory_item_id: Array.from(invItemIds) },
    { take: 500 },
  )

  if (reservationRows.length === 0) {
    return res.json({
      product: { id: product.id, title: product.title, handle: product.handle },
      variants,
      reservations: [],
      note: "no reservation_item rows found — 'reserved' count may be coming from a different inventory_item",
    })
  }

  /* 3. For each reservation, resolve its line item + parent order so
   *    we can see what state the order is in. line_item_id is nullable
   *    on the schema (some reservations are detached/manual) — skip
   *    the lookup if missing. */
  const lineItemIds = reservationRows.map((r) => r.line_item_id).filter(Boolean) as string[]

  let lineItemsByID: Record<string, any> = {}
  if (lineItemIds.length > 0) {
    try {
      const { data: lineItems } = await query.graph({
        entity: "order_line_item",
        fields: [
          "id", "title", "quantity", "variant_id",
          "order.id", "order.display_id", "order.status",
          "order.canceled_at", "order.metadata",
        ],
        filters: { id: lineItemIds },
      })
      for (const li of (lineItems as any[]) ?? []) {
        lineItemsByID[li.id] = li
      }
    } catch (e: any) {
      /* If the entity name differs across Medusa minors, fall back to
       * listing through the order module. */
      try {
        const orderService: any = req.scope.resolve(Modules.ORDER)
        const items = await orderService.listOrderLineItems(
          { id: lineItemIds },
          { take: 500 },
        )
        for (const li of items ?? []) {
          lineItemsByID[li.id] = { ...li, order: null }
        }
      } catch (e2: any) {
        /* Surface the error in the response so we can adjust the query
         * without redeploying blind. */
        return res.status(500).json({
          error: "could not resolve line items",
          graph_error: e?.message,
          fallback_error: e2?.message,
          reservation_count: reservationRows.length,
        })
      }
    }
  }

  const reservations = reservationRows.map((r) => {
    const li = r.line_item_id ? lineItemsByID[r.line_item_id] : null
    return {
      reservation_id: r.id,
      inventory_item_id: r.inventory_item_id,
      location_id: r.location_id,
      quantity: r.quantity,
      created_at: r.created_at,
      deleted_at: r.deleted_at ?? null,
      line_item_id: r.line_item_id,
      description: r.description ?? null,
      metadata: r.metadata ?? null,
      line_item: li ? {
        id: li.id,
        title: li.title,
        quantity: li.quantity,
        variant_id: li.variant_id ?? null,
      } : null,
      order: li?.order ? {
        id: li.order.id,
        display_id: li.order.display_id,
        status: li.order.status,
        canceled_at: li.order.canceled_at ?? null,
      } : null,
    }
  })

  /* Quick orphan flag for at-a-glance read. */
  const orphaned = reservations.filter((r) => r.order && (r.order.status === "canceled" || r.order.status === "cancelled" || r.order.canceled_at))
  const noOrder = reservations.filter((r) => !r.order)

  return res.json({
    product: { id: product.id, title: product.title, handle: product.handle },
    variants,
    summary: {
      total_reservations: reservations.length,
      total_reserved_quantity: reservations.reduce((s, r) => s + Number(r.quantity ?? 0), 0),
      orphaned_against_cancelled_orders: orphaned.length,
      no_order_link: noOrder.length,
    },
    reservations,
  })
}

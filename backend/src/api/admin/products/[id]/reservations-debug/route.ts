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
 * The `:id` path param can be a product id, a product handle, or a
 * variant SKU. Soft-deleted products are included in the search so we
 * can still inspect reservations against archived products.
 *
 * Orphaned reservation = row exists, order.status === "canceled". Those
 * are the ones we expected cancelOrderWorkflow to release.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const param = req.params.id
  if (!param) return res.status(400).json({ error: "missing product id / handle / sku" })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const inventoryService: any = req.scope.resolve(Modules.INVENTORY)
  const productService: any = req.scope.resolve(Modules.PRODUCT)

  /* 1. Resolve the product. Try in order:
   *    (a) by id (active products) via query.graph
   *    (b) by id including soft-deleted via product module listProducts
   *    (c) by handle
   *    (d) by variant.sku → product
   *    For each step we capture what we tried so a 404 explains itself. */
  const tried: string[] = []
  let product: any = null

  try {
    const { data: byId } = await query.graph({
      entity: "product",
      fields: [
        "id", "title", "handle", "deleted_at",
        "variants.id", "variants.sku", "variants.title",
        "variants.inventory_items.required_quantity",
        "variants.inventory_items.inventory.id",
      ],
      filters: { id: param },
    })
    product = (byId as any[])?.[0] ?? null
    tried.push(`query.graph id=${param} → ${product ? "hit" : "miss"}`)
  } catch (e: any) {
    tried.push(`query.graph id=${param} → ERROR ${e?.message}`)
  }

  if (!product) {
    /* Product module's listProducts surfaces soft-deleted rows via
     * withDeleted in the find-config. query.graph filters them out. */
    try {
      const list = await productService.listProducts(
        { id: [param] },
        { withDeleted: true, take: 1 },
      )
      product = list?.[0] ?? null
      tried.push(`product.listProducts(id, withDeleted) → ${product ? "hit (possibly deleted)" : "miss"}`)
    } catch (e: any) {
      tried.push(`product.listProducts(id) → ERROR ${e?.message}`)
    }
  }

  if (!product) {
    try {
      const { data: byHandle } = await query.graph({
        entity: "product",
        fields: [
          "id", "title", "handle",
          "variants.id", "variants.sku", "variants.title",
          "variants.inventory_items.required_quantity",
          "variants.inventory_items.inventory.id",
        ],
        filters: { handle: param },
      })
      product = (byHandle as any[])?.[0] ?? null
      tried.push(`query.graph handle=${param} → ${product ? "hit" : "miss"}`)
    } catch (e: any) {
      tried.push(`query.graph handle=${param} → ERROR ${e?.message}`)
    }
  }

  if (!product) {
    try {
      const { data: byVariantSku } = await query.graph({
        entity: "product_variant",
        fields: [
          "id", "sku", "product.id", "product.title", "product.handle",
        ],
        filters: { sku: param },
      })
      const variant = (byVariantSku as any[])?.[0]
      if (variant?.product?.id) {
        const { data: byId2 } = await query.graph({
          entity: "product",
          fields: [
            "id", "title", "handle",
            "variants.id", "variants.sku", "variants.title",
            "variants.inventory_items.required_quantity",
            "variants.inventory_items.inventory.id",
          ],
          filters: { id: variant.product.id },
        })
        product = (byId2 as any[])?.[0] ?? null
      }
      tried.push(`query.graph variant.sku=${param} → ${product ? "hit" : "miss"}`)
    } catch (e: any) {
      tried.push(`query.graph variant.sku=${param} → ERROR ${e?.message}`)
    }
  }

  if (!product) {
    return res.status(404).json({ error: "product not found", tried })
  }

  /* If product came from the soft-deleted fallback, re-fetch variants
   * via the product module so we get them even when archived. */
  if (!product.variants || product.variants.length === 0) {
    try {
      const fullList = await productService.listProducts(
        { id: [product.id] },
        { withDeleted: true, take: 1, relations: ["variants", "variants.inventory_items"] },
      )
      const full = fullList?.[0]
      if (full?.variants?.length) product.variants = full.variants
    } catch { /* fall through */ }
  }

  const invItemIds = new Set<string>()
  const variants = (product.variants ?? []).map((v: any) => {
    const ids: string[] = []
    /* query.graph nests inventory_items.inventory.id; the product
     * module's relation path exposes inventory_items[].inventory_item_id
     * directly. Handle both shapes. */
    for (const ii of v.inventory_items ?? []) {
      const id = ii.inventory?.id ?? ii.inventory_item_id
      if (id) {
        invItemIds.add(id)
        ids.push(id)
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
      product: { id: product.id, title: product.title, handle: product.handle, deleted_at: product.deleted_at ?? null },
      lookup_trace: tried,
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
      product: { id: product.id, title: product.title, handle: product.handle, deleted_at: product.deleted_at ?? null },
      lookup_trace: tried,
      variants,
      reservations: [],
      note: "no reservation_item rows found for these inventory_items — 'reserved' count may be coming from elsewhere",
    })
  }

  /* 3. For each reservation, resolve its line item + parent order. */
  const lineItemIds = reservationRows.map((r) => r.line_item_id).filter(Boolean) as string[]

  const lineItemsByID: Record<string, any> = {}
  if (lineItemIds.length > 0) {
    try {
      const { data: lineItems } = await query.graph({
        entity: "order_line_item",
        fields: ["id", "title", "quantity", "variant_id"],
        filters: { id: lineItemIds },
      })
      for (const li of (lineItems as any[]) ?? []) {
        lineItemsByID[li.id] = li
      }
    } catch (e: any) {
      try {
        const orderService: any = req.scope.resolve(Modules.ORDER)
        const items = await orderService.listOrderLineItems(
          { id: lineItemIds },
          { take: 500 },
        )
        for (const li of items ?? []) {
          lineItemsByID[li.id] = li
        }
      } catch (e2: any) {
        return res.status(500).json({
          error: "could not resolve line items",
          graph_error: e?.message,
          fallback_error: e2?.message,
          reservation_count: reservationRows.length,
        })
      }
    }
  }

  /* order_line_item → order doesn't walk cleanly via query.graph in
   * this Medusa v2 version (returns null even when the FK exists).
   * Query from the order side instead and build a lineItemId → order
   * map manually. */
  const orderByLineItemID: Record<string, any> = {}
  if (lineItemIds.length > 0) {
    try {
      const { data: orders } = await query.graph({
        entity: "order",
        fields: [
          "id", "display_id", "status", "canceled_at", "metadata",
          "items.id",
        ],
        filters: { items: { id: lineItemIds } },
      })
      for (const o of (orders as any[]) ?? []) {
        for (const it of o.items ?? []) {
          if (it?.id) orderByLineItemID[it.id] = o
        }
      }
    } catch (e: any) {
      /* Fall through; we'll surface partial data. */
    }
  }

  const reservations = reservationRows.map((r) => {
    const li = r.line_item_id ? lineItemsByID[r.line_item_id] : null
    const ord = r.line_item_id ? orderByLineItemID[r.line_item_id] : null
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
      order: ord ? {
        id: ord.id,
        display_id: ord.display_id,
        status: ord.status,
        canceled_at: ord.canceled_at ?? null,
        cancellation_reason_label: ord.metadata?.cancellation_reason_label ?? null,
      } : null,
    }
  })

  const orphaned = reservations.filter((r) => r.order && (r.order.status === "canceled" || r.order.status === "cancelled" || r.order.canceled_at))
  const noOrder = reservations.filter((r) => !r.order)

  return res.json({
    product: { id: product.id, title: product.title, handle: product.handle, deleted_at: product.deleted_at ?? null },
    lookup_trace: tried,
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

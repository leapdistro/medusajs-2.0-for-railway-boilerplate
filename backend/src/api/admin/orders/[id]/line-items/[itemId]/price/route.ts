import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ChangeActionType, ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  beginOrderEditOrderWorkflow,
  cancelBeginOrderEditWorkflow,
  confirmOrderEditRequestWorkflow,
  createOrderChangeActionsWorkflow,
  requestOrderEditRequestWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * POST /admin/orders/:id/line-items/:itemId/price
 * Body: { unit_price: number }
 *
 * Admin-only per-line unit-price edit. Allowed when:
 *   - buyer is on Net-15 terms (customer.metadata.payment_terms === "net15")
 *   - no captured card payment (a price change without a refund/re-charge
 *     would desync the payment from the invoice)
 *   - the QBO invoice, if any, isn't fully paid (qboSettledGuard in
 *     middlewares.ts runs first on this path)
 *
 * Fulfilled and already-invoiced orders are fine: a price-only change
 * doesn't touch quantities, and the confirm emits `order-edit.confirmed`,
 * which the QBO sync subscriber turns into an invoice update (an
 * uninvoiced order picks up the new prices at first push).
 *
 * The edit is previewed before it's confirmed: if Medusa wouldn't land
 * the line at the requested price, the edit is rolled back and nothing
 * changes. Response carries the order total before and after.
 *
 * $0 is refused: the QBO invoice push rejects $0 lines, and Medusa's
 * ITEM_UPDATE skips a falsy unit_price anyway. A free line is removed
 * with Edit Order instead.
 *
 * Uses Medusa's built-in order-edit workflow (begin → add
 * ITEM_UPDATE action with details.unit_price → request → confirm) so
 * order totals are recomputed by the framework's calculate-order-change
 * pipeline. The framework's ITEM_UPDATE action natively accepts
 * unit_price (see @medusajs/order/utils/actions/item-update.js) — quantity
 * is passed through unchanged since the workflow requires it.
 *
 * Audit trail: appends a `price_edits[]` entry to order.metadata
 * capturing { line_item_id, from, to, by, at } — the framework's
 * order_change record has the underlying action too, but this
 * metadata log gives a per-order summary that's queryable by operator.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)

  const orderId = req.params.id
  const itemId = req.params.itemId
  if (!orderId || !itemId) {
    return res.status(400).json({ ok: false, message: "Missing order id or item id" })
  }

  const body = (req.body ?? {}) as { unit_price?: number }
  const newPrice = Math.round(Number(body.unit_price) * 100) / 100
  if (!Number.isFinite(newPrice) || newPrice < 0) {
    return res.status(400).json({ ok: false, message: "unit_price must be a non-negative number" })
  }
  if (newPrice === 0) {
    return res.status(400).json({
      ok: false,
      message: "A line can't be $0 (QuickBooks invoices reject $0 lines). To give it away, remove the item with Edit Order",
    })
  }
  const actorId: string | null = (req as any).auth_context?.actor_id ?? null

  /* Load order with everything we need for guard checks + audit.
   *   - items.quantity can be zeroed after fulfillment cancellation;
   *     items.raw_quantity + items.detail.quantity retain the ordered
   *     qty (same pattern qbo-order-push uses).
   *   - items.unit_price returns the base order_line_item value,
   *     which STAYS at the checkout price after order edits.
   *     items.detail.unit_price is the versioned projection that
   *     reflects the latest edit — read it first, fall back to
   *     items.unit_price for orders that have never been edited. */
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "customer_id", "metadata", "total",
      "items.id", "items.quantity", "items.raw_quantity", "items.detail.quantity",
      "items.unit_price", "items.detail.unit_price", "items.product_title",
      "fulfillments.id", "fulfillments.canceled_at",
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.canceled_at",
    ],
    filters: { id: orderId },
  })
  const order = (orders as any[])[0]
  if (!order) return res.status(404).json({ ok: false, message: `No order ${orderId}` })

  const line = ((order.items ?? []) as any[]).find((it) => it.id === itemId)
  if (!line) {
    return res.status(404).json({ ok: false, message: `Line item ${itemId} not found on order ${orderId}` })
  }

  /* ── Guard: buyer on Net-15 terms, and no captured card payment. */
  const [customer] = await customerService
    .listCustomers({ id: [order.customer_id] }, { take: 1 })
    .catch(() => [])
  const paymentTerms = (customer?.metadata as Record<string, any> | undefined)?.payment_terms
  if (paymentTerms !== "net15") {
    return res.status(400).json({
      ok: false,
      message: "Price editing is only enabled for Net-15 buyers. Card-paid orders would require a refund/re-charge cycle",
    })
  }
  const capturedCardPayment = ((order.payment_collections ?? []) as any[])
    .flatMap((pc) => pc?.payments ?? [])
    .some((p: any) => !!p?.captured_at && !p?.canceled_at)
  if (capturedCardPayment) {
    return res.status(400).json({
      ok: false,
      message: "Order has a captured card payment — editing the price would desync the invoice from what was charged",
    })
  }

  /* Versioned unit_price (order_item.detail.unit_price) wins; base
   * line_item.unit_price is the checkout snapshot and doesn't update
   * on edits. Handle both wrapped ({value:string}) and unwrapped
   * numeric shapes from query.graph. */
  const readPrice = (v: unknown): number => {
    if (v == null) return NaN
    if (typeof v === "number") return v
    if (typeof v === "string") return Number(v)
    /* Medusa BigNumber (previewOrderChange returns these): numeric getter. */
    if (typeof v === "object" && v !== null && "numeric" in v) return Number((v as any).numeric)
    if (typeof v === "object" && v !== null && "value" in v) return Number((v as any).value)
    return Number(v)
  }
  const versionedPrice = readPrice(line.detail?.unit_price)
  const originalPrice = Number.isFinite(versionedPrice) && versionedPrice >= 0
    ? versionedPrice
    : readPrice(line.unit_price)
  /* Resolve quantity from multiple sources — items.quantity zeroes
   * after a fulfillment cancel, raw_quantity + detail.quantity retain
   * the original ordered qty. */
  const rawQtyValue = (line.raw_quantity && typeof line.raw_quantity === "object")
    ? (line.raw_quantity as any).value
    : line.raw_quantity
  const quantity = Number(
    (Number(line.quantity) > 0 ? line.quantity : null)
    ?? (line.detail?.quantity ?? null)
    ?? (rawQtyValue ?? null)
    ?? 0,
  )
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({
      ok: false,
      message: `Line item ${itemId} has invalid quantity (${quantity}) — could not resolve from items.quantity, raw_quantity, or detail.quantity`,
    })
  }

  if (Math.abs(originalPrice - newPrice) < 0.0001) {
    /* No change — return without cycling through the edit workflow. */
    return res.json({ ok: true, changed: false, unit_price: originalPrice })
  }

  /* ── Framework path: begin → add ITEM_UPDATE → preview + verify →
   * request → confirm. Any failure (including a preview that doesn't
   * show the new price) rolls back via cancelBeginOrderEditWorkflow so
   * no PENDING/REQUESTED order_change is left on the order. */
  let orderChangeId: string | null = null
  let totalAfter: number | null = null
  try {
    const { result: change } = await beginOrderEditOrderWorkflow(req.scope).run({
      input: { order_id: orderId, created_by: actorId } as any,
    })
    orderChangeId = String((change as any)?.id ?? "")
    if (!orderChangeId) throw new Error("beginOrderEditOrderWorkflow returned no change id")
    const changeVersion = Number((change as any)?.version ?? 0)

    await createOrderChangeActionsWorkflow(req.scope).run({
      input: [{
        order_change_id: orderChangeId,
        order_id: orderId,
        version: changeVersion,
        action: ChangeActionType.ITEM_UPDATE,
        details: {
          reference_id: itemId,
          /* Quantity is REQUIRED by the framework's ITEM_UPDATE
           * validator. Pass current qty so the action is price-only
           * (and never below the fulfilled qty). */
          quantity,
          unit_price: newPrice,
        },
      }],
    })

    /* What the order would look like once confirmed. */
    const projected: any = await orderService.previewOrderChange(orderId)
    const projectedLine = ((projected?.items ?? []) as any[]).find((it) => it.id === itemId)
    const projectedPrice = readPrice(projectedLine?.detail?.unit_price ?? projectedLine?.unit_price)
    if (!Number.isFinite(projectedPrice) || Math.abs(projectedPrice - newPrice) > 0.005) {
      throw new Error(`The edit would leave this line at ${Number.isFinite(projectedPrice) ? projectedPrice.toFixed(2) : "an unknown price"}, not ${newPrice.toFixed(2)}; nothing was changed.`)
    }
    const projectedTotal = readPrice(projected?.summary?.current_order_total ?? projected?.total)
    totalAfter = Number.isFinite(projectedTotal) ? projectedTotal : null

    await requestOrderEditRequestWorkflow(req.scope).run({
      input: { order_id: orderId, requested_by: actorId } as any,
    })

    await confirmOrderEditRequestWorkflow(req.scope).run({
      input: { order_id: orderId, confirmed_by: actorId } as any,
    })
  } catch (e: any) {
    /* Roll back the edit session so a retry doesn't collide with a
     * stale PENDING change. If cancel also fails, log and surface the
     * original error — the operator can inspect via /admin/orders. */
    if (orderChangeId) {
      try {
        await cancelBeginOrderEditWorkflow(req.scope).run({
          input: { order_id: orderId } as any,
        })
      } catch (cancelErr: any) {
        logger.warn(`[order-price-edit] failed to rollback order_change ${orderChangeId}: ${cancelErr?.message}`)
      }
    }
    logger.error(`[order-price-edit] failed for order ${orderId} line ${itemId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Price edit failed" })
  }

  /* ── Audit trail on order.metadata. Framework has the change action
   * too, but this per-order log is queryable without joining.
   * Re-read metadata first: the confirm above queues the QBO sync,
   * which stamps its own keys here, and writing back the snapshot from
   * before the edit would wipe them. */
  try {
    const { data: fresh } = await query.graph({ entity: "order", fields: ["metadata"], filters: { id: orderId } })
    const metadata = ((fresh as any[])[0]?.metadata ?? {}) as Record<string, any>
    const priceEdits = Array.isArray(metadata.price_edits) ? [...metadata.price_edits] : []
    priceEdits.push({
      line_item_id: itemId,
      product_title: line.product_title ?? line.title ?? null,
      from: originalPrice,
      to: newPrice,
      by: actorId,
      at: new Date().toISOString(),
    })
    await orderService.updateOrders(orderId, { metadata: { ...metadata, price_edits: priceEdits } })
  } catch (e: any) {
    /* Non-fatal — the price change already persisted via the edit
     * workflow. Log the audit failure so it can be reconciled. */
    logger.warn(`[order-price-edit] audit metadata write failed for order ${orderId}: ${e?.message}`)
  }

  const totalBefore = readPrice(order.total)
  logger.info(
    `[order-price-edit] order #${order.display_id} line ${itemId} price ${originalPrice.toFixed(2)} → ${newPrice.toFixed(2)}`,
  )

  return res.json({
    ok: true,
    changed: true,
    line_item_id: itemId,
    unit_price: newPrice,
    previous_unit_price: originalPrice,
    total_before: Number.isFinite(totalBefore) ? totalBefore : null,
    total_after: totalAfter,
    /* The QBO sync queue updates the invoice in the background. */
    qbo_invoice_id: (order.metadata as Record<string, any> | null)?.qbo_invoice_id ?? null,
  })
}

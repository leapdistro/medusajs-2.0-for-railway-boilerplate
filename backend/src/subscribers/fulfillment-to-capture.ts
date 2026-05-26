import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

/**
 * Capture-on-fulfillment subscriber for auth_only mode.
 *
 * When the operator fulfills an order, charge the auth for the
 * amount actually shipped (fulfilled qty × unit_price + shipping).
 * Mirrors the math in qbo-order-push so the QBO invoice + the
 * captured charge always agree.
 *
 * Idempotent — bails when:
 *   - KAJA_CAPTURE_MODE !== "auth_only"   (we ran auth_capture; already captured at checkout)
 *   - No kaja-authnet payment on the order (Net 15 buyer / check / wire)
 *   - The payment's session.data.capture_trans_id is already set (prior fulfillment already captured)
 *
 * Errors are non-blocking: the fulfillment succeeded, the capture
 * failure surfaces on order.metadata.capture_error so the operator
 * can see it on the order detail widget.
 */
export default async function fulfillmentToCaptureHandler({
  event,
  container,
}: SubscriberArgs<{ order_id?: string; id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const mode = (process.env.KAJA_CAPTURE_MODE ?? "auth_capture").toLowerCase()
  if (mode !== "auth_only") {
    /* auth_capture mode = money already moved at checkout. Nothing to do. */
    return
  }

  const orderId = event?.data?.order_id ?? event?.data?.id
  if (!orderId) {
    logger.warn(`[fulfillment-to-capture] no order_id in event; skipping`)
    return
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  let order: any
  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "shipping_total",
        "items.id", "items.quantity", "items.unit_price",
        /* Non-cancelled fulfillment items drive the capture amount —
         * mirrors qbo-order-push.ts so QBO invoice + captured charge
         * always agree. */
        "fulfillments.id", "fulfillments.canceled_at",
        "fulfillments.items.line_item_id", "fulfillments.items.quantity",
        /* Find the kaja-authnet payment to capture. */
        "payment_collections.id",
        "payment_collections.payments.id",
        "payment_collections.payments.provider_id",
        "payment_collections.payments.captured_at",
        "payment_collections.payments.canceled_at",
        "payment_collections.payments.amount",
        "payment_collections.payments.data",
      ],
      filters: { id: [String(orderId)] },
    })
    order = (orders as any[])[0]
    if (!order) return
  } catch (e: any) {
    logger.warn(`[fulfillment-to-capture] couldn't load order ${orderId}: ${e?.message}`)
    return
  }

  /* Find the kaja-authnet payment that's been authorized but not yet
   * captured. captured_at being set means money already moved (the
   * old auth_capture path, or a previous capture this subscriber ran). */
  type Payment = {
    id?: string
    provider_id?: string | null
    captured_at?: string | null
    canceled_at?: string | null
    data?: { trans_id?: string; capture_trans_id?: string } | null
  }
  const payments: Payment[] = (order.payment_collections ?? [])
    .flatMap((pc: any) => (pc?.payments ?? []) as Payment[])
  const target = payments.find(
    (p) => p?.provider_id === "pp_kaja-authnet"
      && !p?.captured_at
      && !p?.canceled_at
      && !!p?.data?.trans_id
      && !p?.data?.capture_trans_id,
  )
  if (!target?.id) {
    /* No matching authorization to capture — either Net 15 (no kaja
     * payment), already captured (auth_capture path or prior fulfillment),
     * or void/canceled. All are valid no-ops. */
    return
  }

  /* Compute capture amount = fulfilled-qty × unit_price + shipping.
   * Lines with 0 fulfilled qty contribute nothing (won't be billed).
   * This mirrors the invoice PDF + QBO push math exactly. */
  const fulfilledByLine = new Map<string, number>()
  for (const f of (order.fulfillments ?? []) as any[]) {
    if (f?.canceled_at) continue
    for (const fi of (f?.items ?? []) as any[]) {
      const lid = fi?.line_item_id
      const qty = Number(fi?.quantity ?? 0)
      if (!lid || !Number.isFinite(qty) || qty <= 0) continue
      fulfilledByLine.set(lid, (fulfilledByLine.get(lid) ?? 0) + qty)
    }
  }
  let linesAmount = 0
  for (const item of order.items ?? []) {
    const fulfilled = fulfilledByLine.get(String(item.id)) ?? 0
    if (fulfilled <= 0) continue
    const unitPrice = Number(item.unit_price ?? 0)
    linesAmount += unitPrice * fulfilled
  }
  const shipping = Number(order.shipping_total ?? 0)
  const captureAmount = Number((linesAmount + shipping).toFixed(2))
  if (captureAmount <= 0) {
    logger.warn(`[fulfillment-to-capture] capture amount is 0 for order ${orderId} — skipping`)
    return
  }

  try {
    const paymentService: any = container.resolve(Modules.PAYMENT)
    /* Stamp capture_amount on payment.data so the provider's
     * capturePayment hook sees the partial amount — Medusa's
     * CapturePaymentInput doesn't carry an `amount` field, so this
     * side-channel is required for "ship 8 of 10" partial captures.
     * Merge with existing data so we don't lose trans_id / opaque_*
     * fields. */
    const existingData = (target.data ?? {}) as Record<string, unknown>
    await paymentService.updatePayment({
      id: target.id,
      data: { ...existingData, capture_amount: captureAmount },
    })
    await paymentService.capturePayment({
      payment_id: target.id,
      amount: captureAmount,
      captured_by: "fulfillment-to-capture-subscriber",
    })
    logger.info(`[fulfillment-to-capture] captured $${captureAmount} on order ${orderId} (payment ${target.id})`)
  } catch (e: any) {
    logger.warn(`[fulfillment-to-capture] capture failed for order ${orderId}: ${e?.message}`)
    /* Stamp the error on order metadata so the admin widget can
     * surface it. Don't throw — the fulfillment itself succeeded. */
    try {
      const orderService: any = container.resolve(Modules.ORDER)
      const [o] = await orderService.listOrders({ id: [String(orderId)] }, { take: 1 })
      if (o) {
        await orderService.updateOrders(o.id, {
          metadata: {
            ...(o.metadata ?? {}),
            capture_error: e?.message ?? "Unknown capture error",
            capture_error_at: new Date().toISOString(),
          },
        })
      }
    } catch (e2: any) {
      logger.warn(`[fulfillment-to-capture] couldn't stamp capture_error: ${e2?.message}`)
    }
  }
}

export const config: SubscriberConfig = {
  event: ["order.fulfillment_created", "fulfillment.created"],
}

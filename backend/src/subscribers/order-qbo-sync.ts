import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { syncOrderToQbo } from "../lib/qbo-order-sync"
import { sendFeedNotification } from "../lib/feed-notification"

/**
 * Every change to an order re-syncs its QBO Invoice (lib/qbo-order-sync):
 * the first fulfillment creates it, later edits / returns / fulfillment
 * cancellations / cancellations update or void it. Replaces the old
 * fulfillment-only push subscriber.
 *
 * Errors don't throw (that would make Medusa retry forever): they're
 * stamped on the order for the QBO widget and ring the admin bell.
 */
export default async function orderQboSyncHandler({
  event,
  container,
}: SubscriberArgs<{ order_id?: string; id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  /* order.canceled carries { id }; every other event here carries
   * { order_id, ... } (its `id`, when present, is the fulfillment /
   * return / claim id). */
  const orderId = event.name === "order.canceled"
    ? event.data?.id
    : event.data?.order_id
  if (!orderId) {
    logger.warn(`[order-qbo-sync] ${event.name} without an order id; skipping`)
    return
  }

  const outcome = await syncOrderToQbo(container, String(orderId), {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  })
  if (outcome.ok === true) {
    logger.info(`[order-qbo-sync] ${event.name} → order ${orderId}: ${outcome.action} (${outcome.message})`)
    return
  }
  if (outcome.ok !== false) return

  logger.warn(`[order-qbo-sync] ${event.name} → order ${orderId} failed (${outcome.code}): ${outcome.error}`)
  let displayId: number | string | null = null
  try {
    const { Modules } = await import("@medusajs/framework/utils")
    const orderService: any = container.resolve(Modules.ORDER)
    const [order] = await orderService.listOrders({ id: [String(orderId)] }, { take: 1 })
    displayId = order?.display_id ?? null
    /* First-push failures keep stamping qbo_push_error, which the widget
     * and the existing retry flow already read. */
    if (order && !order.metadata?.qbo_invoice_id) {
      await orderService.updateOrders(order.id, {
        metadata: { ...(order.metadata ?? {}), qbo_push_error: outcome.error, qbo_push_error_at: new Date().toISOString() },
      })
    }
  } catch (e: any) {
    logger.warn(`[order-qbo-sync] couldn't stamp push error: ${e?.message}`)
  }
  const orderLabel = displayId != null ? `#${displayId}` : `${String(orderId).slice(0, 8)}…`
  await sendFeedNotification(container, {
    title: `QBO sync failed for order ${orderLabel}`,
    description:
      `Reason: ${outcome.code}\n` +
      `${(outcome.error ?? "").slice(0, 200)}\n` +
      `Open: /app/orders/${orderId} — use the QuickBooks widget to retry.`,
  })
}

export const config: SubscriberConfig = {
  event: [
    "order.fulfillment_created",
    "order.fulfillment_canceled",
    "order-edit.confirmed",
    "order.return_received",
    "order.claim_created",
    "order.exchange_created",
    "order.canceled",
  ],
}

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { pushOrderToQbo } from "../lib/qbo-order-push"

/**
 * When an admin marks an order as Fulfilled (`order.fulfillment_created`
 * event fires), auto-push the order to QBO as an Invoice — and, for
 * KAJA-paid orders, a Payment that closes the invoice immediately so it
 * lands as PAID.
 *
 * Idempotent — bails if order.metadata.qbo_invoice_id is already set.
 * Errors are non-blocking: the fulfillment succeeded, the push fail just
 * surfaces on the order detail page so the operator can retry.
 */
export default async function fulfillmentToQboHandler({
  event,
  container,
}: SubscriberArgs<{ order_id?: string; id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  /* Medusa fires several fulfillment events with slightly different
   * payload shapes; the order id is usually under data.order_id. */
  const orderId = event?.data?.order_id ?? event?.data?.id
  if (!orderId) {
    logger.warn(`[fulfillment-to-qbo] no order_id in event; skipping. event=${JSON.stringify(event).slice(0, 200)}`)
    return
  }

  const outcome = await pushOrderToQbo(container, String(orderId), {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  })

  if (outcome.ok === true) {
    logger.info(`[fulfillment-to-qbo] pushed order ${orderId} → Invoice ${outcome.invoiceId}`)
    return
  }

  /* Surface push failures via order.metadata so the order-qbo-status
   * widget can render them. Don't throw — that would mark the
   * subscriber failed in Medusa's job runner and retry forever. */
  if (outcome.code === "ALREADY_PUSHED") {
    logger.info(`[fulfillment-to-qbo] order ${orderId} already pushed (Invoice ${outcome.invoiceId})`)
    return
  }

  const errMsg = outcome.error
  logger.warn(`[fulfillment-to-qbo] push failed (${outcome.code}) for order ${orderId}: ${errMsg}`)
  try {
    const { Modules } = await import("@medusajs/framework/utils")
    const orderService: any = container.resolve(Modules.ORDER)
    const [order] = await orderService.listOrders({ id: [String(orderId)] }, { take: 1 })
    if (order) {
      await orderService.updateOrders(order.id, {
        metadata: {
          ...(order.metadata ?? {}),
          qbo_push_error: errMsg,
          qbo_push_error_at: new Date().toISOString(),
        },
      })
    }
  } catch (e: any) {
    logger.warn(`[fulfillment-to-qbo] couldn't stamp push error: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: ["order.fulfillment_created", "fulfillment.created"],
}

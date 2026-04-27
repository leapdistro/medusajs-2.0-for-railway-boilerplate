import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { sendOrderPlacedEmails } from '../modules/email-notifications/lib/order-email-data'

/**
 * order.placed subscriber — delegates to sendOrderPlacedEmails so the
 * exact same logic runs from /admin/orders/:id/resend-confirmation
 * (manual trigger). This isolates "did the event fire" from "did the
 * email logic work" when debugging.
 */
export default async function orderPlacedHandler({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  /* DIAGNOSTIC: top-line log proving the handler ran. If this never
   * appears in Railway logs after placing an order, the order.placed
   * event isn't reaching us — check event name + subscriber registration.
   * Keep until emails are confirmed sending. */
  logger.info(`[order-placed] HANDLER INVOKED for order ${data?.id ?? '(no id)'}`)

  const result = await sendOrderPlacedEmails(container, data.id)
  if (!result.ok) {
    logger.warn(`[order-placed] partial/failed for order ${result.displayId ?? data.id}: ${result.errors.join(' | ')}`)
  } else {
    logger.info(`[order-placed] sent ${[result.receivedSent && 'received', result.teamAlertSent && 'team', result.paymentInstructionsSent && 'payment'].filter(Boolean).join(' + ')} for order ${result.displayId}`)
  }
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}

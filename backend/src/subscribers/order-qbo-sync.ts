import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { enqueueOrderSync, runSyncJob } from "../lib/qbo-sync-queue"

/**
 * Every change to an order re-syncs its QBO Invoice. The change is first
 * saved as a job (lib/qbo-sync-queue.ts) so it survives a QBO outage or
 * a restart, then run straight away; if that attempt fails, the
 * every-minute job (jobs/qbo-sync-retry.ts) retries it with backoff and
 * surfaces it in admin if it still can't go through.
 */
export default async function orderQboSyncHandler({
  event,
  container,
}: SubscriberArgs<{ order_id?: string; id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  /* order.canceled carries { id }; every other event here carries
   * { order_id, ... } (its `id`, when present, is the fulfillment /
   * return / claim id). */
  const orderId = event.name === "order.canceled" ? event.data?.id : event.data?.order_id
  if (!orderId) {
    logger.warn(`[order-qbo-sync] ${event.name} without an order id; skipping`)
    return
  }
  const log = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m), error: (m: string) => logger.error(m) }
  try {
    const job = await enqueueOrderSync(container, String(orderId), event.name)
    const outcome = await runSyncJob(container, job.id, log)
    if (outcome?.ok === true) logger.info(`[order-qbo-sync] ${event.name} → order ${orderId}: ${outcome.action} (${outcome.message})`)
  } catch (e: any) {
    /* Even enqueueing failed (DB hiccup) — nothing else will retry this,
     * so make it loud. */
    logger.error(`[order-qbo-sync] couldn't queue ${event.name} for order ${orderId}: ${e?.message}`)
  }
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

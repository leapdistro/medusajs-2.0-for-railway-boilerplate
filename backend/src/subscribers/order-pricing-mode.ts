import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { stampOrderPricingMode } from "../lib/order-pricing-mode"

/**
 * Backup for the stamp send-confirmation makes at checkout: also covers
 * orders placed without the storefront (draft orders from admin).
 */
export default async function orderPricingModeHandler({
  event,
  container,
}: SubscriberArgs<{ id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = event.data?.id
  if (!orderId) return
  try {
    await stampOrderPricingMode(container, orderId)
  } catch (e: any) {
    logger.warn(`[order-pricing-mode] couldn't stamp order ${orderId}: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}

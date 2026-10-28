import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Saves the buyer's pricing mode on the order (metadata.pricing_mode) at
 * placement, so Analytics groups the order by the mode it was priced at
 * even after the customer moves to another mode. "default" when the
 * buyer has none. Never overwrites a stamp already there, so calling it
 * twice (send-confirmation + order.placed) is harmless.
 */
export async function stampOrderPricingMode(scope: any, orderId: string): Promise<string | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "metadata", "customer.metadata"],
    filters: { id: orderId },
  })
  const order = data?.[0]
  if (!order) return null
  if (order.metadata?.pricing_mode) return order.metadata.pricing_mode
  const mode = (order.customer?.metadata?.pricing_mode as string | undefined) || "default"
  await scope.resolve(Modules.ORDER).updateOrders(order.id, {
    metadata: { ...(order.metadata ?? {}), pricing_mode: mode },
  })
  return mode
}

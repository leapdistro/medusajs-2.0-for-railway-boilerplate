import { ORDER_HISTORY_MODULE } from "../modules/order-history"

export type HistoryActor = { type: "admin" | "customer" | "system" | "qbo"; id?: string | null }

/**
 * Append one entry to an order's History. Best-effort: a logging failure
 * never breaks the action being logged.
 */
export async function logOrderHistory(
  scope: any,
  orderId: string,
  entry: { action: string; summary: string; actor?: HistoryActor; details?: Record<string, unknown> | null; at?: Date },
): Promise<void> {
  try {
    const history: any = scope.resolve(ORDER_HISTORY_MODULE)
    await history.createOrderHistoryEvents({
      order_id: orderId,
      occurred_at: entry.at ?? new Date(),
      actor_type: entry.actor?.type ?? "system",
      actor_id: entry.actor?.id ?? null,
      action: entry.action,
      summary: entry.summary,
      details: entry.details ?? null,
    })
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn(`[order-history] couldn't log ${entry.action} for ${orderId}: ${e?.message}`)
  }
}

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"
import { readInvoice } from "./qbo-api"
import { SETTLED_MESSAGE, isSettled } from "./qbo-order-sync"
import { logOrderHistory } from "./order-history-log"

/**
 * Refuse order changes once the order's QBO invoice is fully paid.
 *
 * Medusa 2.13's edit / return / claim / exchange / cancel workflows have
 * no validation hook, so this runs as route middleware on the admin
 * requests that START each of those flows. The order id comes from the
 * path (:id) or the body (order_id). Medusa admin shows the 400 message
 * as an error toast.
 *
 * Fails OPEN: if QBO can't be reached the change goes ahead and the
 * follow-up sync reports SETTLED instead — a QBO outage must not freeze
 * order operations.
 */
export async function qboSettledGuard(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = (req.params?.id as string | undefined)
    ?? ((req.body ?? {}) as { order_id?: string }).order_id
  if (!orderId || !String(orderId).startsWith("order_")) return next()
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "order", fields: ["id", "display_id", "metadata"], filters: { id: orderId } })
    const invoiceId = (data as any[])[0]?.metadata?.qbo_invoice_id
    if (!invoiceId) return next()
    const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)
    const [conn] = await qbo.listQboConnections({}, { take: 1 })
    if (!conn) return next()
    const inv = await readInvoice(qbo, conn, String(invoiceId))
    if (isSettled(inv)) {
      const adminId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id ?? null
      await logOrderHistory(req.scope, String(orderId), {
        action: "change_blocked",
        summary: `Change blocked — invoice ${inv.DocNumber ?? invoiceId} is fully paid (${describeAttempt(req)})`,
        actor: { type: "admin", id: adminId },
        details: { path: req.path ?? null, invoice_id: String(invoiceId) },
      })
      res.status(400).json({
        type: "not_allowed",
        message: `${SETTLED_MESSAGE} (Invoice ${inv.DocNumber ?? invoiceId})`,
      })
      return
    }
  } catch (e: any) {
    logger.warn(`[qbo-settled-guard] check failed for ${orderId}, allowing: ${e?.message}`)
  }
  next()
}

function describeAttempt(req: MedusaRequest): string {
  const p = String(req.path ?? req.url ?? "")
  if (p.includes("order-edits")) return "order edit"
  if (p.includes("returns")) return "return"
  if (p.includes("claims")) return "claim"
  if (p.includes("exchanges")) return "exchange"
  if (p.includes("/price")) return "price edit"
  if (p.includes("fulfillments")) return "fulfillment cancel"
  if (p.includes("cancel")) return "cancellation"
  return "order change"
}

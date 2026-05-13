import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { pushOrderToQbo } from "../../../../../lib/qbo-order-push"

/**
 * POST /admin/orders/:id/push-to-qbo
 *
 * Manual retry for the same push the fulfillment subscriber runs.
 * Used when:
 *   - The order was created/fulfilled before this slice shipped
 *   - The subscriber failed (QBO down, missing item, etc.) and operator
 *     fixed the underlying issue
 *   - Operator wants to (re)push for any reason
 *
 * Idempotent: returns 409 with the existing invoice id if already pushed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, error: "Missing order id" })

  const outcome = await pushOrderToQbo(req.scope, orderId, {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  })

  if (outcome.ok === true) {
    return res.json({
      ok: true,
      invoiceId: outcome.invoiceId,
      balance: outcome.balance,
      paymentId: outcome.paymentId,
      url: outcome.url,
    })
  }
  if (outcome.code === "ALREADY_PUSHED") {
    return res.status(409).json({ ok: false, code: outcome.code, invoiceId: outcome.invoiceId })
  }
  const code = outcome.code
  const status = code === "NOT_CONNECTED" ? 400
              : code === "NO_CUSTOMER"   ? 400
              : code === "MISSING_ITEM"  ? 422
              : 500
  return res.status(status).json({ ok: false, code, error: outcome.error })
}

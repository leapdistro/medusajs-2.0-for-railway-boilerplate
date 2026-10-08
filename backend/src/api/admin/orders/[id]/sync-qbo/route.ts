import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { syncOrderToQbo } from "../../../../../lib/qbo-order-sync"
import { resolveOrderJobs } from "../../../../../lib/qbo-sync-queue"

/**
 * POST /admin/orders/:id/sync-qbo
 *
 * Manual "Sync now" from the order's QuickBooks widget — the same
 * reconcile the order-change subscriber runs.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, error: "Missing order id" })

  const outcome = await syncOrderToQbo(req.scope, orderId, {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  })
  if (outcome.ok === true) {
    await resolveOrderJobs(req.scope, orderId).catch(() => {})
    return res.json(outcome)
  }
  const failed = outcome as { code: string }
  const status = failed.code === "SETTLED" || failed.code === "BELOW_PAID" || failed.code === "VOIDED" ? 409
    : failed.code === "LOCKED" ? 423
    : failed.code === "NOT_CONNECTED" || failed.code === "NO_CUSTOMER" ? 400
    : failed.code === "MISSING_ITEM" || failed.code === "TOTAL_MISMATCH" ? 422
    : 500
  return res.status(status).json(outcome)
}

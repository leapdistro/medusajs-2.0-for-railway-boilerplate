import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refreshOrderPayment } from "../../../../../lib/qbo-inbound"

/**
 * POST /admin/orders/:id/qbo-payment
 *
 * "Check payment" on the order's QuickBooks widget: re-read the invoice
 * from QBO and record its payment status, marking the order paid in
 * Medusa when QBO says it's paid in full. Same path as the webhook.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const result = await refreshOrderPayment(req.scope, req.params.id, logger)
    if (!result.invoiceId) return res.status(400).json({ ok: false, message: "Order hasn't been pushed to QuickBooks yet" })
    return res.json({ ok: true, ...result })
  } catch (e: any) {
    logger.error(`[qbo-payment] order ${req.params.id}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Couldn't read the invoice from QuickBooks" })
  }
}

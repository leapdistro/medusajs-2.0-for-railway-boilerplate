import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { sendOrderPlacedEmails } from "../../../../../modules/email-notifications/lib/order-email-data"

/**
 * POST /admin/orders/:id/resend-confirmation
 *
 * Manually fires the same 3 emails the order.placed subscriber would
 * (Order Received, Team Alert, Payment Instructions). Exists for two
 * reasons:
 *   1. Diagnostic — proves the email assembly + send pipeline works
 *      independently of the event bus. If this works but no emails
 *      arrive after placing a real order, the bug is the subscriber
 *      not being invoked (event name wrong, build skipped subscribers,
 *      etc.) — NOT the email code.
 *   2. Operator utility — buyer didn't get the original confirmation?
 *      Resend without writing custom scripts.
 *
 * Returns the structured send result so the caller (curl / future
 * admin UI button) sees exactly which of the 3 emails fired.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, message: "Missing order id" })

  const result = await sendOrderPlacedEmails(req.scope, orderId)
  res.status(result.ok ? 200 : 500).json(result)
}

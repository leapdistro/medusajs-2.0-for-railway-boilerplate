import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { sendOrderPlacedEmails } from "../../../../../../modules/email-notifications/lib/order-email-data"

/**
 * POST /store/mbs/orders/:id/send-confirmation
 * Body: { customerEmail: string }
 *
 * Storefront calls this from /api/checkout/complete right after
 * cart.complete() returns successfully. Synchronous, deterministic —
 * doesn't depend on Medusa's order.placed event firing.
 *
 * Auth gate (defense-in-depth):
 *   1. Publishable key — Medusa enforces on /store/* namespace
 *   2. customerEmail in body must match order.email
 *
 * #2 stops a hostile caller who knows an order id from triggering
 * notification spam to wholesale@hempmbs.com. The buyer email going to
 * its rightful owner isn't a meaningful abuse vector, but the team
 * alert is — hence the email match.
 *
 * Idempotent — operator can also fire this manually if a buyer's first
 * email bounced, by curling with the right email body.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, message: "Missing order id" })

  const body = (req.body ?? {}) as { customerEmail?: string }
  const customerEmail = body.customerEmail?.trim().toLowerCase()
  if (!customerEmail) {
    return res.status(400).json({ ok: false, message: "customerEmail required in body" })
  }

  // Verify the order exists AND its email matches the caller's claim.
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  let orderEmail: string | null = null
  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "email"],
      filters: { id: orderId },
    })
    const order = orders?.[0]
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" })
    orderEmail = (order.email ?? "").toLowerCase()
  } catch (e: any) {
    logger.warn(`[send-confirmation] order lookup failed: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not load order" })
  }

  if (orderEmail !== customerEmail) {
    logger.warn(`[send-confirmation] email mismatch for order ${orderId}: caller=${customerEmail} order=${orderEmail}`)
    return res.status(403).json({ ok: false, message: "Email does not match order" })
  }

  const result = await sendOrderPlacedEmails(req.scope, orderId)
  res.status(result.ok ? 200 : 500).json(result)
}

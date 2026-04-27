import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { sendPaymentInstructionsEmail } from "../../../../../modules/email-notifications/lib/order-email-data"

/**
 * POST /admin/orders/:id/send-payment-instructions
 *
 * Operator-triggered Payment Instructions email. Used for non-card
 * orders (check/wire/Net Terms). Auto-firing on order placement was
 * removed once it became clear most future orders will go through KAJA
 * cards — this is now the rare exception that needs explicit operator
 * action.
 *
 * Stamps order.metadata.payment_instructions_sent_at on success so the
 * widget can show "Sent on X" / "Resend".
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, message: "Missing order id" })

  const result = await sendPaymentInstructionsEmail(req.scope, orderId)
  if (!result.ok) {
    return res.status(500).json(result)
  }

  // Stamp metadata so the widget can show last-sent timestamp.
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      filters: { id: orderId },
    })
    const order = orders?.[0]
    if (order) {
      await orderService.updateOrders(orderId, {
        metadata: {
          ...(order.metadata ?? {}),
          payment_instructions_sent_at: new Date().toISOString(),
        },
      })
    }
  } catch {
    // Stamp failure is cosmetic — email already sent. Don't fail the response.
  }

  return res.json(result)
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows"
import { MBS_SETTINGS_MODULE } from "../../../../../modules/mbs-settings"
import { EmailTemplates } from "../../../../../modules/email-notifications/templates"
import {
  computeTotals,
  formatMoney,
  loadEmailSettings,
  pickContactName,
} from "../../../../../modules/email-notifications/lib/order-email-data"

/**
 * POST /admin/orders/:id/cancel-with-reason
 *
 * Body: { reasonId, operatorNote? }
 *
 * Resolves the cancellation reason label from mbs-settings.cancellation_reasons,
 * cancels the order via the canonical cancelOrderWorkflow (releases inventory
 * reservations, marks status cancelled, etc.), stamps the reason on metadata,
 * and emails the customer the branded cancellation email.
 */

type CancelBody = {
  reasonId?: string
  operatorNote?: string
}

type Reason = { id: string; label: string; archived?: boolean }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, message: "Missing order id" })

  const body = (req.body ?? {}) as CancelBody
  if (!body.reasonId) return res.status(400).json({ ok: false, message: "reasonId is required" })

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const reasons = ((await settings.getSetting("cancellation_reasons", [])) ?? []) as Reason[]
  const reason = reasons.find((r) => r.id === body.reasonId && !r.archived)
  if (!reason) {
    return res.status(400).json({
      ok: false,
      message: `Unknown or archived reason "${body.reasonId}". Refresh and pick again.`,
    })
  }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  let order: any
  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "email", "customer_id", "status", "metadata",
        "currency_code", "shipping_total", "tax_total",
        "*items",
        "*payment_collections", "*payment_collections.payments",
      ],
      filters: { id: orderId },
    })
    order = orders?.[0]
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" })
  } catch (e: any) {
    logger.warn(`[cancel-with-reason] could not load order ${orderId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not load order" })
  }

  if (order.status === "canceled" || order.status === "cancelled") {
    return res.status(409).json({ ok: false, message: "Order is already cancelled" })
  }

  // Stamp metadata FIRST (in case workflow fails, we want the reason recorded).
  const cancelledAt = new Date().toISOString()
  try {
    await orderService.updateOrders(order.id, {
      metadata: {
        ...(order.metadata ?? {}),
        cancellation_reason_id: reason.id,
        cancellation_reason_label: reason.label,
        cancellation_operator_note: body.operatorNote?.trim() || null,
        cancelled_at_intent: cancelledAt,
      },
    })
  } catch (e: any) {
    logger.warn(`[cancel-with-reason] metadata update failed (continuing to workflow): ${e?.message}`)
  }

  // Run the canonical cancel workflow — releases reservations, marks
  // status. If this fails the email shouldn't go out either.
  try {
    await cancelOrderWorkflow(req.scope).run({ input: { order_id: order.id } })
  } catch (e: any) {
    logger.warn(`[cancel-with-reason] cancelOrderWorkflow failed: ${e?.message}`)
    return res.status(500).json({ ok: false, message: `Cancel failed: ${e?.message}` })
  }

  // Detect refund eligibility — order had captured payment.
  const captured = (order.payment_collections ?? []).some((c: any) =>
    (c.payments ?? []).some((p: any) => p?.captured_at)
  )
  const totals = computeTotals(order)
  const refundAmountFormatted = captured ? formatMoney(totals.grandTotal, order.currency_code ?? "usd") : null

  // Email best-effort.
  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendKey || !resendFrom) {
    return res.json({ ok: true, cancelledAt, emailSent: false, message: "Cancelled — email skipped (no Resend env)." })
  }
  if (!order.email) {
    return res.json({ ok: true, cancelledAt, emailSent: false, message: "Cancelled — order has no email on file." })
  }

  const emailSettings = await loadEmailSettings(req.scope)
  let customer: any = null
  if (order.customer_id) {
    try {
      const list = await customerService.listCustomers({ id: [order.customer_id] }, { take: 1 })
      customer = list?.[0] ?? null
    } catch { /* fall through */ }
  }

  const displayId = String(order.display_id ?? order.id)
  try {
    const notificationService: any = req.scope.resolve(Modules.NOTIFICATION)
    await notificationService.createNotifications([{
      to: order.email,
      channel: "email",
      template: EmailTemplates.ORDER_CANCELLED,
      from: resendFrom,
      data: {
        emailOptions: { subject: `Order #${displayId} cancelled` },
        displayId,
        contactName: pickContactName(order, customer),
        reasonLabel: reason.label,
        operatorNote: body.operatorNote?.trim() || null,
        refunded: captured,
        refundAmountFormatted,
        contactEmail: emailSettings.contact.email,
        contactPhone: emailSettings.contact.phone,
      },
    }])
  } catch (e: any) {
    logger.warn(`[cancel-with-reason] email send failed: ${e?.message}`)
    return res.status(500).json({ ok: false, cancelledAt, emailSent: false, message: `Cancelled but email failed: ${e?.message}` })
  }

  return res.json({ ok: true, cancelledAt, emailSent: true })
}

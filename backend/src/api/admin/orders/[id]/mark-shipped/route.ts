import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { EmailTemplates } from "../../../../../modules/email-notifications/templates"
import {
  loadEmailSettings,
  pickAddress,
  pickContactName,
} from "../../../../../modules/email-notifications/lib/order-email-data"

/**
 * POST /admin/orders/:id/mark-shipped
 *
 * Body: { carrier, trackingNumber, trackingUrl?, estimatedDelivery?, operatorNote? }
 *
 * Stamps the order's metadata (shipped_at, carrier, tracking details,
 * operator note) and emails the customer the branded "shipped" email.
 *
 * NOTE: this does NOT create a Medusa Fulfillment record — that's
 * deferred to the ShipStation integration in the next phase. For now
 * the metadata + email are the user-visible behavior.
 *
 * Idempotent-ish: re-running with the same fields just updates timestamp
 * + re-sends. Operator can use as a "resend" path if the buyer didn't
 * get the first one (toast confirms send result either way).
 */

type MarkShippedBody = {
  carrier?: string
  trackingNumber?: string
  trackingUrl?: string
  estimatedDelivery?: string
  operatorNote?: string
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = req.params.id
  if (!orderId) return res.status(400).json({ ok: false, message: "Missing order id" })

  const body = (req.body ?? {}) as MarkShippedBody
  if (!body.carrier?.trim())        return res.status(400).json({ ok: false, message: "Carrier is required" })
  if (!body.trackingNumber?.trim()) return res.status(400).json({ ok: false, message: "Tracking number is required" })

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  let order: any
  try {
    /* Wildcards don't work on Order entity in v2 — explicit dotted paths. */
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "email", "customer_id", "metadata",
        "shipping_address.first_name", "shipping_address.last_name", "shipping_address.company",
        "shipping_address.address_1", "shipping_address.address_2",
        "shipping_address.city", "shipping_address.province", "shipping_address.postal_code",
        "shipping_address.country_code", "shipping_address.phone",
      ],
      filters: { id: orderId },
    })
    order = orders?.[0]
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" })
  } catch (e: any) {
    logger.warn(`[mark-shipped] could not load order ${orderId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not load order" })
  }

  // Stamp shipping metadata.
  const shippedAt = new Date().toISOString()
  try {
    await orderService.updateOrders(order.id, {
      metadata: {
        ...(order.metadata ?? {}),
        shipped_at: shippedAt,
        shipping_carrier: body.carrier.trim(),
        shipping_tracking_number: body.trackingNumber.trim(),
        shipping_tracking_url: body.trackingUrl?.trim() || null,
        shipping_estimated_delivery: body.estimatedDelivery?.trim() || null,
        shipping_operator_note: body.operatorNote?.trim() || null,
      },
    })
  } catch (e: any) {
    logger.warn(`[mark-shipped] metadata update failed: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not save shipping metadata" })
  }

  // Send email (best-effort — state is already stamped).
  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendKey || !resendFrom) {
    return res.json({ ok: true, shippedAt, emailSent: false, message: "Saved — email skipped (no Resend env)." })
  }
  if (!order.email) {
    return res.json({ ok: true, shippedAt, emailSent: false, message: "Saved — order has no email on file." })
  }

  const settings = await loadEmailSettings(req.scope)
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
      template: EmailTemplates.ORDER_SHIPPED,
      from: resendFrom,
      data: {
        emailOptions: { subject: `Order #${displayId} shipped — ${body.carrier.trim()} ${body.trackingNumber.trim()}` },
        displayId,
        contactName: pickContactName(order, customer),
        carrier: body.carrier.trim(),
        trackingNumber: body.trackingNumber.trim(),
        trackingUrl: body.trackingUrl?.trim() || null,
        estimatedDelivery: body.estimatedDelivery?.trim() || null,
        shippingAddress: pickAddress(order.shipping_address),
        operatorNote: body.operatorNote?.trim() || null,
        contactEmail: settings.contact.email,
        contactPhone: settings.contact.phone,
      },
    }])
  } catch (e: any) {
    logger.warn(`[mark-shipped] email send failed: ${e?.message}`)
    return res.status(500).json({ ok: false, shippedAt, emailSent: false, message: `Saved but email failed: ${e?.message}` })
  }

  return res.json({ ok: true, shippedAt, emailSent: true })
}

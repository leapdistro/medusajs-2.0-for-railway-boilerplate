import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { EmailTemplates } from '../modules/email-notifications/templates'
import {
  computeTotals,
  describeProvider,
  formatMoney,
  loadEmailSettings,
  pickAddress,
  pickContactName,
  pickLineItems,
  pickPaymentProviderId,
  pickShippingMethodName,
} from '../modules/email-notifications/lib/order-email-data'

const TEAM_NOTIFICATION_TO = 'wholesale@hempmbs.com'

/**
 * order.placed subscriber — sends three emails:
 *
 *   1. ORDER_RECEIVED        → buyer (always)
 *   2. ORDER_TEAM_ALERT      → wholesale@hempmbs.com (always)
 *   3. PAYMENT_INSTRUCTIONS  → buyer (only when payment provider needs
 *      out-of-band payment, e.g. pp_system_default. KAJA card/ACH skips.)
 *
 * Each email is independent — one failing doesn't block the others.
 * Without RESEND env vars set, all three log + skip cleanly.
 */
export default async function orderPlacedHandler({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendKey || !resendFrom) {
    logger.info(`[order-placed] RESEND env not set — skipping all emails for order ${data.id}`)
    return
  }

  /* Pull the order with everything emails need. Notes on field syntax:
   *   - `*items` / `*shipping_address` work because items + addresses
   *     are direct relations on the Order entity.
   *   - `payment_collections` is a SEPARATE module (Payment), connected
   *     via a module link. Wildcards (`*payment_collections`) don't
   *     traverse module links — they throw a Mikro-ORM
   *     "does not have property" error. Use explicit dotted paths.
   *   - Same is true for shipping_options' price_set (we hit this in
   *     fix-shipping-prices).
   */
  let order: any
  try {
    const { data: orders } = await query.graph({
      entity: 'order',
      fields: [
        'id', 'display_id', 'email', 'customer_id', 'currency_code', 'created_at',
        'shipping_total', 'tax_total', 'subtotal', 'total',
        '*items', '*items.product', 'items.product.images.url',
        '*shipping_address',
        '*billing_address',
        '*shipping_methods',
        'payment_collections.id',
        'payment_collections.payment_sessions.provider_id',
        'payment_collections.payments.provider_id',
        'payment_collections.payments.captured_at',
      ],
      filters: { id: data.id },
    })
    order = orders?.[0]
    if (!order) {
      logger.warn(`[order-placed] order ${data.id} not found — skipping emails`)
      return
    }
  } catch (e: any) {
    logger.error(`[order-placed] query.graph failed for order ${data.id}: ${e?.message}`)
    return
  }

  // Look up customer for businessName + fallback name fields.
  let customer: any = null
  if (order.customer_id) {
    try {
      const list = await customerService.listCustomers({ id: [order.customer_id] }, { take: 1 })
      customer = list?.[0] ?? null
    } catch (e: any) {
      logger.warn(`[order-placed] customer ${order.customer_id} lookup failed: ${e?.message}`)
    }
  }
  const businessName: string | null =
    (typeof customer?.metadata?.business_name === 'string' && customer.metadata.business_name) ||
    (typeof customer?.company_name === 'string' && customer.company_name) || null

  // Common pieces shared by all three templates.
  const settings = await loadEmailSettings(container)
  const items = pickLineItems(order)
  const totals = computeTotals(order)
  const currency = order.currency_code ?? 'usd'
  const provider = describeProvider(pickPaymentProviderId(order))
  const shippingMethodName = pickShippingMethodName(order)
  const contactName = pickContactName(order, customer)
  const displayId = String(order.display_id ?? order.id)

  const moneyArgs = (n: number) => formatMoney(n, currency)

  const notificationModuleService: any = container.resolve(Modules.NOTIFICATION)

  // ─── 1. Customer "order received" ──────────────────────────────────
  if (order.email) {
    try {
      await notificationModuleService.createNotifications([{
        to: order.email,
        channel: 'email',
        template: EmailTemplates.ORDER_RECEIVED,
        from: resendFrom,
        data: {
          emailOptions: { subject: `Order #${displayId} received — we'll send tracking soon` },
          displayId,
          contactName,
          businessName,
          items,
          itemsTotalFormatted:    moneyArgs(totals.itemsTotal),
          shippingTotalFormatted: moneyArgs(totals.shippingTotal),
          taxTotalFormatted:      moneyArgs(totals.taxTotal),
          grandTotalFormatted:    moneyArgs(totals.grandTotal),
          shippingAddress: pickAddress(order.shipping_address),
          billingAddress:  pickAddress(order.billing_address),
          shippingMethodName,
          paymentLabel: provider.label,
          needsPaymentInstructions: provider.needsInstructions,
        },
      }])
    } catch (e: any) {
      logger.warn(`[order-placed] customer ORDER_RECEIVED failed: ${e?.message}`)
    }
  }

  // ─── 2. Team alert ────────────────────────────────────────────────
  try {
    await notificationModuleService.createNotifications([{
      to: TEAM_NOTIFICATION_TO,
      channel: 'email',
      template: EmailTemplates.ORDER_TEAM_ALERT,
      from: resendFrom,
      data: {
        emailOptions: { subject: `[MBS] New order #${displayId} — ${moneyArgs(totals.grandTotal)} from ${businessName || contactName}` },
        displayId,
        orderId: order.id,
        customerEmail: order.email ?? '(no email)',
        contactName,
        businessName,
        items,
        itemsTotalFormatted:    moneyArgs(totals.itemsTotal),
        shippingTotalFormatted: moneyArgs(totals.shippingTotal),
        taxTotalFormatted:      moneyArgs(totals.taxTotal),
        grandTotalFormatted:    moneyArgs(totals.grandTotal),
        shippingAddress: pickAddress(order.shipping_address),
        billingAddress:  pickAddress(order.billing_address),
        shippingMethodName,
        paymentLabel: provider.label,
      },
    }])
  } catch (e: any) {
    logger.warn(`[order-placed] team ORDER_TEAM_ALERT failed: ${e?.message}`)
  }

  // ─── 3. Payment Instructions (conditional on provider) ─────────────
  if (provider.needsInstructions && order.email) {
    try {
      await notificationModuleService.createNotifications([{
        to: order.email,
        channel: 'email',
        template: EmailTemplates.PAYMENT_INSTRUCTIONS,
        from: resendFrom,
        data: {
          emailOptions: { subject: `Payment instructions for Order #${displayId} — ${moneyArgs(totals.grandTotal)} due` },
          displayId,
          contactName,
          amountDueFormatted: moneyArgs(totals.grandTotal),
          payment: {
            ...settings.payment,
            // Inject a contextual memo line if the operator's default mentions Order #
            memo_instruction: settings.payment.memo_instruction?.replace(/Order #N/i, `Order #${displayId}`),
          },
          contactEmail: settings.contact.email,
          contactPhone: settings.contact.phone,
        },
      }])
    } catch (e: any) {
      logger.warn(`[order-placed] customer PAYMENT_INSTRUCTIONS failed: ${e?.message}`)
    }
  }

  logger.info(`[order-placed] sent emails for order ${displayId} (${order.id})`)
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}

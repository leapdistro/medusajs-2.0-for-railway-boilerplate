/**
 * Shared helpers for assembling order-related email data — keeps the
 * subscriber + admin route handlers tiny and identical-by-construction
 * (so customer + team emails always show the exact same totals/addresses).
 */
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../mbs-settings"
import { EmailTemplates } from "../templates"

/* Friendly labels for payment provider IDs. Mirrors the storefront's
 * PROVIDER_LABELS map (src/lib/cart.ts). When we add KAJA, add a row
 * here AND on the storefront. */
const PROVIDER_LABELS: Record<string, string> = {
  pp_system_default: "Check / Wire / Net Terms",
  // pp_kaja: "Card or ACH",
}

/* Provider IDs that need a separate "Payment Instructions" email
 * (because the buyer has to do something out-of-band to pay). KAJA-style
 * card/ACH providers go here as `false` once added. */
const PROVIDER_NEEDS_INSTRUCTIONS: Record<string, boolean> = {
  pp_system_default: true,
}

export type ContactInfo = {
  support_email?: string
  support_phone?: string
  hours?: string
}

export type PaymentInfo = {
  dba?: string
  mailing_address?: string
  bank?: {
    bank_name?: string
    beneficiary_name?: string
    routing_number?: string
    account_number?: string
    swift_code?: string
    account_type?: string
  }
  net_terms_default?: string
  memo_instruction?: string
}

export function formatMoney(amount: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount)
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`
  }
}

/** Coerce any Medusa v2 money value to a plain number. v2 wraps monetary
 *  fields in BigNumber objects (sometimes plain numbers, sometimes
 *  `{ numeric: 120 }`, sometimes `{ value: "120.00" }`, sometimes the
 *  `raw_<field>: { value: "120" }` sibling). `Number(bigNumberObject)`
 *  → NaN → defaults to 0 — which is exactly the "items show $0" bug
 *  we hit in the order emails. */
export function asNumber(v: unknown): number {
  if (v == null) return 0
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  if (typeof v === "object") {
    const obj = v as any
    if (typeof obj.numeric === "number" && Number.isFinite(obj.numeric)) return obj.numeric
    if (typeof obj.value === "string") {
      const n = Number(obj.value)
      if (Number.isFinite(n)) return n
    }
    if (typeof obj.value === "number" && Number.isFinite(obj.value)) return obj.value
    if (obj.raw) return asNumber(obj.raw)
  }
  return 0
}

/** Resolve provider id → friendly label + whether it needs a separate
 *  payment-instructions email. */
export function describeProvider(providerId?: string | null): { label: string; needsInstructions: boolean } {
  const id = providerId ?? "pp_system_default"
  return {
    label: PROVIDER_LABELS[id] ?? id,
    needsInstructions: PROVIDER_NEEDS_INSTRUCTIONS[id] ?? false,
  }
}

/** Pick the first address out of order.shipping_address / billing_address.
 *  Templates accept null fields, so passing through unmodified is fine. */
export function pickAddress(a: any): any {
  if (!a) return {}
  return {
    first_name:   a.first_name   ?? null,
    last_name:    a.last_name    ?? null,
    company:      a.company      ?? null,
    address_1:    a.address_1    ?? null,
    address_2:    a.address_2    ?? null,
    city:         a.city         ?? null,
    province:     a.province     ?? null,
    postal_code:  a.postal_code  ?? null,
    country_code: a.country_code ?? null,
    phone:        a.phone        ?? null,
  }
}

/** Build the line-item rows used by ORDER_RECEIVED + ORDER_TEAM_ALERT.
 *  Money fields go through asNumber() because v2 wraps them in BigNumber
 *  objects — Number(bigNumberObject) is NaN, which previously made the
 *  emails show $0 for every line. Thumbnail comes from the line-item
 *  snapshot Medusa stores at add-to-cart time (li.thumbnail), with
 *  product.thumbnail / first image as fallbacks. The buyer-facing
 *  template shows it as a tiny 60×60 square; team template ignores. */
export function pickLineItems(order: any): Array<{
  title: string
  variantTitle?: string | null
  qty: number
  unitPriceFormatted: string
  subtotalFormatted: string
  thumbnail?: string | null
}> {
  const currency = order.currency_code ?? "usd"
  return (order.items ?? []).map((it: any) => {
    const qty       = asNumber(it.quantity)  || asNumber(it.raw_quantity)
    const unitPrice = asNumber(it.unit_price) || asNumber(it.raw_unit_price)
    const subtotal  = asNumber(it.subtotal)   || asNumber(it.raw_subtotal) || (unitPrice * qty)
    return {
      title: it.product_title ?? it.title ?? "",
      variantTitle: it.variant_title ?? it.subtitle ?? null,
      qty,
      unitPriceFormatted: formatMoney(unitPrice, currency),
      subtotalFormatted:  formatMoney(subtotal,  currency),
      thumbnail: it.thumbnail ?? it.product?.thumbnail ?? it.product?.images?.[0]?.url ?? null,
    }
  })
}

/** Read totals straight from Medusa's pre-computed order fields. In v2,
 *  Order.subtotal = sum of line items (no shipping, no tax, no discounts);
 *  Order.total = subtotal - discounts + shipping + tax. We use these
 *  directly instead of hand-summing items — Medusa already did the math
 *  (including discounts, promos, etc. that we'd miss).
 *
 *  Fallbacks layered for resilience:
 *    1. order.<field>          (BigNumber object — usually present)
 *    2. order.raw_<field>      (string-payload sibling — guaranteed)
 *    3. hand-sum of items.subtotal (only for itemsTotal, only if both
 *       above are missing — should never happen on a real order). */
export function computeTotals(order: any): {
  itemsTotal: number
  shippingTotal: number
  taxTotal: number
  grandTotal: number
} {
  const itemsTotal =
    asNumber(order.subtotal) ||
    asNumber(order.raw_subtotal) ||
    (order.items ?? []).reduce((s: number, i: any) => {
      const sub =
        asNumber(i.subtotal) ||
        asNumber(i.raw_subtotal) ||
        ((asNumber(i.unit_price) || asNumber(i.raw_unit_price)) * (asNumber(i.quantity) || asNumber(i.raw_quantity)))
      return s + sub
    }, 0)

  const shippingTotal = asNumber(order.shipping_total) || asNumber(order.raw_shipping_total)
  const taxTotal      = asNumber(order.tax_total)      || asNumber(order.raw_tax_total)
  const grandTotal    =
    asNumber(order.total) ||
    asNumber(order.raw_total) ||
    (itemsTotal + shippingTotal + taxTotal)

  return { itemsTotal, shippingTotal, taxTotal, grandTotal }
}

/** Pull contact + payment info from mbs-settings with sensible defaults
 *  so emails never crash on missing settings. */
export async function loadEmailSettings(container: any): Promise<{
  contact: { email: string; phone?: string }
  payment: PaymentInfo
}> {
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const contactRaw = ((await settings.getSetting("contact_info", {})) ?? {}) as ContactInfo
  const paymentRaw = ((await settings.getSetting("payment_info", {})) ?? {}) as PaymentInfo
  return {
    contact: {
      email: contactRaw.support_email?.trim() || "wholesale@hempmbs.com",
      phone: contactRaw.support_phone?.trim() || undefined,
    },
    payment: {
      dba:             paymentRaw.dba             || "MBS LLC",
      mailing_address: paymentRaw.mailing_address || "",
      bank:            paymentRaw.bank            || {},
      net_terms_default: paymentRaw.net_terms_default || "",
      memo_instruction:  paymentRaw.memo_instruction  || "",
    },
  }
}

/** Best-effort contact name from order or customer. */
export function pickContactName(order: any, customer?: any): string {
  const fromBilling = [order?.billing_address?.first_name, order?.billing_address?.last_name].filter(Boolean).join(" ").trim()
  if (fromBilling) return fromBilling
  const fromShipping = [order?.shipping_address?.first_name, order?.shipping_address?.last_name].filter(Boolean).join(" ").trim()
  if (fromShipping) return fromShipping
  const fromCustomer = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim()
  if (fromCustomer) return fromCustomer
  return order?.email ?? "there"
}

/** Pick the cart's chosen shipping method label (most recent = index 0). */
export function pickShippingMethodName(order: any): string {
  return order?.shipping_methods?.[0]?.name ?? "—"
}

/** Pick the chosen payment provider id from the order's payment_collections. */
export function pickPaymentProviderId(order: any): string | null {
  const coll = order?.payment_collections?.[0]
  const session = coll?.payment_sessions?.[0]
  return session?.provider_id ?? coll?.payments?.[0]?.provider_id ?? null
}

const TEAM_NOTIFICATION_TO = "wholesale@hempmbs.com"

/**
 * Sends the 3 order-placed emails (Order Received, Team Alert, Payment
 * Instructions) for the given order. Used by BOTH the order.placed
 * subscriber AND the manual-resend admin route — keeps the assembly
 * logic identical so a successful manual send proves the data path
 * works and isolates failures to event wiring.
 *
 * Returns a structured result so callers (admin route) can show the
 * operator exactly what fired/skipped/failed.
 */
export type OrderPlacedSendResult = {
  ok: boolean
  orderId: string
  displayId?: string
  receivedSent?: boolean
  teamAlertSent?: boolean
  paymentInstructionsSent?: boolean
  paymentInstructionsSkipped?: boolean
  errors: string[]
}

export async function sendOrderPlacedEmails(container: any, orderId: string): Promise<OrderPlacedSendResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const result: OrderPlacedSendResult = { ok: false, orderId, errors: [] }

  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendKey || !resendFrom) {
    result.errors.push("RESEND_API_KEY or RESEND_FROM_EMAIL not set")
    return result
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  /* Pull the order with everything emails need. Wildcards (*field) DO
   * NOT work on the Order entity in Medusa v2 (unlike Cart) — they
   * throw "Entity 'Order' does not have property '*items'" or similar.
   * Use explicit dotted paths for every field instead. */
  let order: any
  try {
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "email", "customer_id", "currency_code", "created_at",
        "shipping_total", "tax_total", "subtotal", "total",
        "raw_shipping_total", "raw_tax_total", "raw_subtotal", "raw_total",
        // Items (explicit fields, no wildcards). raw_* siblings carry the
        // BigNumber payload as a string, so we have a fallback if the
        // primary field comes through as an opaque object.
        "items.id", "items.title", "items.product_title", "items.variant_title",
        "items.quantity", "items.unit_price", "items.subtotal", "items.thumbnail",
        "items.raw_unit_price", "items.raw_subtotal", "items.raw_quantity",
        "items.product_id",
        "items.product.id", "items.product.thumbnail",
        "items.product.images.url",
        // Addresses
        "shipping_address.first_name", "shipping_address.last_name", "shipping_address.company",
        "shipping_address.address_1", "shipping_address.address_2",
        "shipping_address.city", "shipping_address.province", "shipping_address.postal_code",
        "shipping_address.country_code", "shipping_address.phone",
        "billing_address.first_name", "billing_address.last_name", "billing_address.company",
        "billing_address.address_1", "billing_address.address_2",
        "billing_address.city", "billing_address.province", "billing_address.postal_code",
        "billing_address.country_code", "billing_address.phone",
        // Shipping methods
        "shipping_methods.id", "shipping_methods.name", "shipping_methods.amount",
        // Payment collections (Payment is a separate module — dotted only)
        "payment_collections.id",
        "payment_collections.payment_sessions.provider_id",
        "payment_collections.payments.provider_id",
        "payment_collections.payments.captured_at",
      ],
      filters: { id: orderId },
    })
    order = orders?.[0]
    if (!order) {
      result.errors.push(`Order ${orderId} not found`)
      return result
    }
  } catch (e: any) {
    result.errors.push(`query.graph failed: ${e?.message}`)
    logger.error(`[order-emails] query.graph failed for ${orderId}: ${e?.message}`)
    return result
  }

  result.displayId = String(order.display_id ?? order.id)

  // Customer lookup for businessName + fallback name.
  let customer: any = null
  if (order.customer_id) {
    try {
      const list = await customerService.listCustomers({ id: [order.customer_id] }, { take: 1 })
      customer = list?.[0] ?? null
    } catch (e: any) {
      logger.warn(`[order-emails] customer ${order.customer_id} lookup failed: ${e?.message}`)
    }
  }
  const businessName: string | null =
    (typeof customer?.metadata?.business_name === "string" && customer.metadata.business_name) ||
    (typeof customer?.company_name === "string" && customer.company_name) || null

  const settings = await loadEmailSettings(container)
  const items = pickLineItems(order)
  const totals = computeTotals(order)
  const currency = order.currency_code ?? "usd"
  const provider = describeProvider(pickPaymentProviderId(order))
  const shippingMethodName = pickShippingMethodName(order)
  const contactName = pickContactName(order, customer)
  const displayId = result.displayId
  const moneyArgs = (n: number) => formatMoney(n, currency)
  const notificationModuleService: any = container.resolve(Modules.NOTIFICATION)

  // 1. Customer "order received"
  if (order.email) {
    try {
      await notificationModuleService.createNotifications([{
        to: order.email,
        channel: "email",
        template: EmailTemplates.ORDER_RECEIVED,
        from: resendFrom,
        data: {
          emailOptions: { subject: `Order #${displayId} received — we'll send tracking soon` },
          displayId, contactName, businessName, items,
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
      result.receivedSent = true
    } catch (e: any) {
      result.errors.push(`ORDER_RECEIVED failed: ${e?.message}`)
      logger.warn(`[order-emails] ORDER_RECEIVED failed: ${e?.message}`)
    }
  } else {
    result.errors.push("Order has no email — skipped customer emails")
  }

  // 2. Team alert
  try {
    await notificationModuleService.createNotifications([{
      to: TEAM_NOTIFICATION_TO,
      channel: "email",
      template: EmailTemplates.ORDER_TEAM_ALERT,
      from: resendFrom,
      data: {
        emailOptions: { subject: `[MBS] New order #${displayId} — ${moneyArgs(totals.grandTotal)} from ${businessName || contactName}` },
        displayId,
        orderId: order.id,
        customerEmail: order.email ?? "(no email)",
        contactName, businessName, items,
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
    result.teamAlertSent = true
  } catch (e: any) {
    result.errors.push(`ORDER_TEAM_ALERT failed: ${e?.message}`)
    logger.warn(`[order-emails] ORDER_TEAM_ALERT failed: ${e?.message}`)
  }

  // 3. Payment Instructions (conditional)
  if (provider.needsInstructions && order.email) {
    try {
      await notificationModuleService.createNotifications([{
        to: order.email,
        channel: "email",
        template: EmailTemplates.PAYMENT_INSTRUCTIONS,
        from: resendFrom,
        data: {
          emailOptions: { subject: `Payment instructions for Order #${displayId} — ${moneyArgs(totals.grandTotal)} due` },
          displayId, contactName,
          amountDueFormatted: moneyArgs(totals.grandTotal),
          payment: {
            ...settings.payment,
            memo_instruction: settings.payment.memo_instruction?.replace(/Order #N/i, `Order #${displayId}`),
          },
          contactEmail: settings.contact.email,
          contactPhone: settings.contact.phone,
        },
      }])
      result.paymentInstructionsSent = true
    } catch (e: any) {
      result.errors.push(`PAYMENT_INSTRUCTIONS failed: ${e?.message}`)
      logger.warn(`[order-emails] PAYMENT_INSTRUCTIONS failed: ${e?.message}`)
    }
  } else {
    result.paymentInstructionsSkipped = true
  }

  result.ok = result.errors.length === 0
  return result
}

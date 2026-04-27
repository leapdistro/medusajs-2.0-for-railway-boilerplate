/**
 * Shared helpers for assembling order-related email data — keeps the
 * subscriber + admin route handlers tiny and identical-by-construction
 * (so customer + team emails always show the exact same totals/addresses).
 */
import { MBS_SETTINGS_MODULE } from "../../mbs-settings"

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
 *  Thumbnail comes from the line-item snapshot Medusa stores at
 *  add-to-cart time (li.thumbnail), with product.thumbnail / first image
 *  as fallbacks. The buyer-facing template shows it as a tiny 60×60
 *  square next to each line; the team template ignores the field. */
export function pickLineItems(order: any): Array<{
  title: string
  variantTitle?: string | null
  qty: number
  unitPriceFormatted: string
  subtotalFormatted: string
  thumbnail?: string | null
}> {
  const currency = order.currency_code ?? "usd"
  return (order.items ?? []).map((it: any) => ({
    title: it.product_title ?? it.title ?? "",
    variantTitle: it.variant_title ?? it.subtitle ?? null,
    qty: Number(it.quantity ?? 0),
    unitPriceFormatted: formatMoney(Number(it.unit_price ?? 0), currency),
    subtotalFormatted:  formatMoney(Number(it.subtotal ?? (Number(it.unit_price ?? 0) * Number(it.quantity ?? 0))), currency),
    thumbnail: it.thumbnail ?? it.product?.thumbnail ?? it.product?.images?.[0]?.url ?? null,
  }))
}

/** Sum line-item subtotals — order.subtotal in v2 has inconsistent
 *  semantics, so we recompute the unambiguous sum (same approach the
 *  storefront cart view uses). */
export function computeTotals(order: any): {
  itemsTotal: number
  shippingTotal: number
  taxTotal: number
  grandTotal: number
} {
  const itemsTotal = (order.items ?? []).reduce(
    (s: number, i: any) => s + Number(i.subtotal ?? (Number(i.unit_price ?? 0) * Number(i.quantity ?? 0))),
    0
  )
  const shippingTotal = Number(order.shipping_total ?? 0)
  const taxTotal      = Number(order.tax_total ?? 0)
  return {
    itemsTotal,
    shippingTotal,
    taxTotal,
    grandTotal: itemsTotal + shippingTotal + taxTotal,
  }
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

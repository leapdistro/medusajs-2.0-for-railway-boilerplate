import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Read-only diagnostic for "why does this customer's order total show $0?"
 *
 * Pulls every order for the supplied EMAIL, then for each order with a
 * suspicious total (0, missing, or NaN) prints:
 *   - display_id, created_at, status, fulfillment_status, payment_status
 *   - top-level totals (subtotal, shipping_total, tax_total, total)
 *   - per-line: title, quantity, unit_price, subtotal, variant.id, sku
 *   - shipping_methods amounts
 *   - payment_collections summary (provider, captured, refunds)
 *
 * Surfaces patterns: zero-priced variants (pricing model regression),
 * orders placed during a draft state (no totals calculated yet), partial
 * line subtotals that look wrong, etc.
 *
 * Usage:
 *   EMAIL=wsscustomerservice@gmail.com pnpm exec medusa exec ./src/scripts/diagnose-zero-totals.ts
 */
export default async function diagnoseZeroTotals({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  const email = (process.env.EMAIL ?? "").trim().toLowerCase()
  if (!email) {
    logger.error("Pass EMAIL=foo@bar.com")
    return
  }

  const customers = await customerService.listCustomers({ email: [email] }, { take: 1 })
  const customer = customers?.[0]
  if (!customer) {
    logger.error(`No customer found for ${email}`)
    return
  }
  logger.info(`Customer ${customer.id} (${customer.email})`)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "created_at", "status",
      "fulfillment_status", "payment_status",
      "subtotal", "shipping_total", "tax_total", "total",
      "raw_subtotal", "raw_total",
      "items.id", "items.title", "items.quantity",
      "items.unit_price", "items.subtotal",
      "items.raw_unit_price", "items.raw_subtotal",
      "items.variant_id", "items.variant_sku",
      "shipping_methods.id", "shipping_methods.name", "shipping_methods.amount",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.amount",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.refunds.amount",
    ],
    filters: { customer_id: customer.id },
  })

  const orderList = (orders as any[]) ?? []
  logger.info(`Found ${orderList.length} orders for ${email}`)
  logger.info("─────────────────────────────────────────────────────────────")

  const suspicious = orderList.filter((o) => {
    const total = asNumber(o.total)
    return !Number.isFinite(total) || total <= 0
  })

  logger.info(`${suspicious.length} suspicious order(s) (total <= 0 or NaN)`)
  logger.info("")

  for (const o of suspicious) {
    logger.info(`── ORDER #${o.display_id} (${o.id})`)
    logger.info(`   status=${o.status} fulfillment=${o.fulfillment_status ?? "—"} payment=${o.payment_status ?? "—"}`)
    logger.info(`   created=${o.created_at}`)
    logger.info(`   subtotal=$${fmt(o.subtotal)} ship=$${fmt(o.shipping_total)} tax=$${fmt(o.tax_total)} total=$${fmt(o.total)}`)
    logger.info(`   raw_subtotal=${JSON.stringify(o.raw_subtotal)} raw_total=${JSON.stringify(o.raw_total)}`)
    logger.info(`   items (${(o.items ?? []).length}):`)
    for (const it of o.items ?? []) {
      logger.info(`     · ${String(it.title).slice(0, 40).padEnd(40)} qty=${it.quantity} unit=$${fmt(it.unit_price)} sub=$${fmt(it.subtotal)} sku=${it.variant_sku ?? "—"}`)
      logger.info(`       raw_unit_price=${JSON.stringify(it.raw_unit_price)} raw_subtotal=${JSON.stringify(it.raw_subtotal)} variant_id=${it.variant_id}`)
    }
    const sm = (o.shipping_methods ?? [])[0]
    if (sm) logger.info(`   ship_method: ${sm.name} = $${fmt(sm.amount)}`)
    const pmt = ((o.payment_collections ?? [])[0]?.payments ?? [])[0]
    if (pmt) {
      const refunds = (pmt.refunds ?? []).reduce((s: number, r: any) => s + asNumber(r.amount), 0)
      logger.info(`   payment: provider=${pmt.provider_id} amount=$${fmt(pmt.amount)} captured=${pmt.captured_at ?? "no"} refunds=$${refunds.toFixed(2)}`)
    } else {
      logger.info(`   payment: (none)`)
    }
    logger.info("")
  }

  if (suspicious.length === 0) {
    logger.info("No orders match the suspicious criteria. Spot-check:")
    for (const o of orderList.slice(-5)) {
      logger.info(`  · #${o.display_id} total=$${fmt(o.total)} items=${(o.items ?? []).length}`)
    }
  }
}

function asNumber(v: any): number {
  if (v == null) return 0
  if (typeof v === "number") return v
  if (typeof v === "string") return Number(v) || 0
  if (typeof v === "object") {
    if (typeof v.numeric === "number") return v.numeric
    if (typeof v.value === "string") return Number(v.value) || 0
  }
  return Number(v) || 0
}
function fmt(v: any): string {
  return asNumber(v).toFixed(2)
}

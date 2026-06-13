import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * Inspect — for a list of order display_ids, dump the order's
 * customer linkage + QBO push state. Used to diagnose cases where
 * an order landed in the wrong QBO customer account.
 *
 * Prints, per order:
 *   - order.id, display_id, email (order-level)
 *   - order.customer_id, order.metadata.qbo_invoice_id
 *   - customer.id, email, phone, business_name
 *   - customer.metadata.qbo_customer_id
 *
 * Side-by-side comparison shows whether two orders share a customer,
 * an email, or a QBO customer id (without using phone).
 *
 * Usage:
 *   DIAG_DISPLAY_IDS='34,35' pnpm inspect:orders-qbo
 */

const IDS = (process.env.DIAG_DISPLAY_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)

export default async function inspectOrdersQbo({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  if (IDS.length === 0) {
    logger.error("❌ DIAG_DISPLAY_IDS env var required (comma-separated). Example: DIAG_DISPLAY_IDS='34,35'")
    return
  }

  logger.info(`═══ INSPECT ORDERS → QBO LINKAGE — display_ids=[${IDS.join(", ")}] ═══`)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "email", "customer_id", "metadata",
      "customer.id", "customer.email", "customer.phone", "customer.metadata",
    ],
    filters: { display_id: IDS.map((s) => Number(s)).filter((n) => Number.isFinite(n)) },
  })

  if (!orders?.length) {
    logger.error(`No orders found for display_ids=[${IDS.join(", ")}]`)
    return
  }

  for (const o of orders as any[]) {
    const c = o.customer ?? {}
    const cMeta = (c.metadata ?? {}) as Record<string, any>
    const oMeta = (o.metadata ?? {}) as Record<string, any>
    logger.info("")
    logger.info(`── Order #${o.display_id} ──`)
    logger.info(`  order.id:                       ${o.id}`)
    logger.info(`  order.email:                    ${o.email}`)
    logger.info(`  order.customer_id:              ${o.customer_id}`)
    logger.info(`  order.metadata.qbo_invoice_id:  ${oMeta.qbo_invoice_id ?? "—"}`)
    logger.info(`  order.metadata.qbo_push_error:  ${oMeta.qbo_push_error ?? "—"}`)
    logger.info(`  customer.id:                    ${c.id}`)
    logger.info(`  customer.email:                 ${c.email}`)
    logger.info(`  customer.phone:                 ${c.phone}`)
    logger.info(`  customer.business_name:         ${cMeta.business_name ?? "—"}`)
    logger.info(`  customer.qbo_customer_id:       ${cMeta.qbo_customer_id ?? "—"}`)
  }

  /* Cross-comparison summary — show which orders share keys. */
  logger.info("")
  logger.info(`── Cross-comparison ──`)
  const sameCustomerId = new Set((orders as any[]).map((o) => o.customer_id)).size === 1
  const sameEmail = new Set((orders as any[]).map((o) => String(o.customer?.email ?? "").toLowerCase())).size === 1
  const samePhone = new Set((orders as any[]).map((o) => String(o.customer?.phone ?? "").replace(/\D/g, ""))).size === 1
  const sameQboId = new Set((orders as any[]).map((o) => o.customer?.metadata?.qbo_customer_id ?? "—")).size === 1
  logger.info(`  same Medusa customer_id?  ${sameCustomerId ? "YES (orders are on the same customer)" : "no"}`)
  logger.info(`  same email?               ${sameEmail ? "YES" : "no"}`)
  logger.info(`  same phone (digits)?      ${samePhone ? "YES" : "no"}`)
  logger.info(`  same qbo_customer_id?     ${sameQboId ? "YES (both pushes target same QBO customer)" : "no"}`)
  logger.info("")
  logger.info("═══ END ═══")
}

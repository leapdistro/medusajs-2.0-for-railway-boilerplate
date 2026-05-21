import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * Wipe every Medusa-side QBO id stamp so the next sync against the
 * production QBO realm re-pushes everything fresh. Used during the
 * sandbox → production cutover — sandbox QBO ids are meaningless once
 * we re-authorize against prod credentials.
 *
 * What gets wiped:
 *   - customer.metadata.qbo_customer_id, qbo_ein_attachment_id,
 *     qbo_license_attachment_id, qbo_attachments_pushed_at
 *   - order.metadata.qbo_invoice_id, qbo_payment_id, qbo_push_error,
 *     qbo_push_error_at
 *   - receiving_record.qbo_bill_id column
 *
 * What does NOT need wiping:
 *   - Product / variant / category records — we don't persist a QBO
 *     item id on the Medusa side; findOrCreateItem looks up by
 *     name + category on every push, so prod will resolve correctly.
 *   - qbo_connection row — that gets deleted separately as part of the
 *     cutover (sandbox tokens won't validate against prod endpoints
 *     anyway).
 *
 * Safety: dry-run by default. Logs counts of what would clear. Pass
 * APPLY=1 to actually wipe.
 *
 * Usage:
 *   pnpm exec medusa exec ./src/scripts/clear-sandbox-qbo-ids.ts
 *   APPLY=1 pnpm exec medusa exec ./src/scripts/clear-sandbox-qbo-ids.ts
 */

const CUSTOMER_KEYS = [
  "qbo_customer_id",
  "qbo_ein_attachment_id",
  "qbo_license_attachment_id",
  "qbo_attachments_pushed_at",
] as const

const ORDER_KEYS = [
  "qbo_invoice_id",
  "qbo_payment_id",
  "qbo_push_error",
  "qbo_push_error_at",
] as const

export default async function clearSandboxQboIds({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const apply = process.env.APPLY === "1"

  const customerService: any = container.resolve(Modules.CUSTOMER)
  const orderService: any    = container.resolve(Modules.ORDER)
  const receivingService: any = container.resolve(RECEIVING_HISTORY_MODULE)

  logger.info("▶ Scanning for sandbox QBO id stamps…")

  /* ─── 1. Customers ─── */
  /* Paginate — the customer module's listCustomers returns up to take
   * rows at a time. Default take is small; bump it to chew through the
   * full set in one or two pages. */
  const allCustomers: any[] = []
  let offset = 0
  const pageSize = 200
  while (true) {
    const page = await customerService.listCustomers({}, { take: pageSize, skip: offset })
    if (!page?.length) break
    allCustomers.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }
  const customersWithIds = allCustomers.filter((c) => {
    const m = c.metadata ?? {}
    return CUSTOMER_KEYS.some((k) => m[k] != null)
  })
  logger.info(`  customers: ${customersWithIds.length} of ${allCustomers.length} carry one or more QBO id stamps`)

  /* ─── 2. Orders ─── */
  const allOrders: any[] = []
  offset = 0
  while (true) {
    const page = await orderService.listOrders({}, { take: pageSize, skip: offset })
    if (!page?.length) break
    allOrders.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }
  const ordersWithIds = allOrders.filter((o) => {
    const m = o.metadata ?? {}
    return ORDER_KEYS.some((k) => m[k] != null)
  })
  logger.info(`  orders:    ${ordersWithIds.length} of ${allOrders.length} carry one or more QBO id stamps`)

  /* ─── 3. Receiving records ─── */
  const allReceivings: any[] = []
  offset = 0
  while (true) {
    const page = await receivingService.listReceivingRecords({}, { take: pageSize, skip: offset })
    if (!page?.length) break
    allReceivings.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }
  const receivingsWithIds = allReceivings.filter((r: any) => r.qbo_bill_id != null)
  logger.info(`  receivings: ${receivingsWithIds.length} of ${allReceivings.length} carry a qbo_bill_id`)

  const total = customersWithIds.length + ordersWithIds.length + receivingsWithIds.length
  if (total === 0) {
    logger.info("─────────────────────────────────")
    logger.info("Nothing to wipe — all QBO id stamps are already clear.")
    return
  }

  if (!apply) {
    logger.info("─────────────────────────────────")
    logger.info("DRY RUN — no records changed.")
    logger.info("Re-run with APPLY=1 to actually wipe.")
    return
  }

  logger.warn("▶ APPLY=1 — wiping in 3s. Cancel now if wrong.")
  await new Promise((r) => setTimeout(r, 3000))

  /* ─── Wipe customers ─── */
  let customerOk = 0, customerFail = 0
  for (const c of customersWithIds) {
    /* Set each QBO key to null on metadata. updateCustomers MERGES
     * metadata (rather than replacing it), so nulled fields stick AND
     * unrelated metadata (business_name, ein, etc.) survives. */
    const wipe: Record<string, any> = {}
    for (const k of CUSTOMER_KEYS) {
      if ((c.metadata ?? {})[k] != null) wipe[k] = null
    }
    try {
      await customerService.updateCustomers(c.id, { metadata: { ...(c.metadata ?? {}), ...wipe } })
      customerOk += 1
    } catch (e: any) {
      logger.warn(`  ! customer ${c.id} update failed: ${e?.message}`)
      customerFail += 1
    }
  }
  logger.info(`  ✓ customers: ${customerOk} wiped (${customerFail} failed)`)

  /* ─── Wipe orders ─── */
  let orderOk = 0, orderFail = 0
  for (const o of ordersWithIds) {
    const wipe: Record<string, any> = {}
    for (const k of ORDER_KEYS) {
      if ((o.metadata ?? {})[k] != null) wipe[k] = null
    }
    try {
      await orderService.updateOrders(o.id, { metadata: { ...(o.metadata ?? {}), ...wipe } })
      orderOk += 1
    } catch (e: any) {
      logger.warn(`  ! order ${o.id} update failed: ${e?.message}`)
      orderFail += 1
    }
  }
  logger.info(`  ✓ orders: ${orderOk} wiped (${orderFail} failed)`)

  /* ─── Wipe receiving records (real column, not metadata) ─── */
  let receivingOk = 0, receivingFail = 0
  for (const r of receivingsWithIds) {
    try {
      await receivingService.updateReceivingRecords({ id: r.id, qbo_bill_id: null })
      receivingOk += 1
    } catch (e: any) {
      logger.warn(`  ! receiving ${r.id} update failed: ${e?.message}`)
      receivingFail += 1
    }
  }
  logger.info(`  ✓ receivings: ${receivingOk} wiped (${receivingFail} failed)`)

  logger.info("─────────────────────────────────")
  logger.info(`✓ Sandbox QBO id stamps cleared.`)
  logger.info(`  Next sync against prod will re-push customers, orders, and bills fresh.`)
  logger.info(`  Don't forget to also DELETE the qbo_connection row + flip QBO_ENVIRONMENT=production.`)
}

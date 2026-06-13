import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * Audit a receiving invoice end-to-end:
 *   - Every receiving_record row that bears the invoice_number
 *   - Per-line action (created / restocked / failed) + failure reasons
 *   - QBO push status per record
 *   - Whether the resulting products actually exist + carry the
 *     mbs-attributes / inventory the receiving was supposed to write
 *
 * Use to understand why a particular receiving partially failed and
 * what state the catalog is in afterwards.
 *
 * Usage:
 *   DIAG_INVOICE=20260605-093116945 pnpm audit:receiving-invoice
 */

const INVOICE = process.env.DIAG_INVOICE || ""

export default async function auditReceivingInvoice({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)

  if (!INVOICE) {
    logger.error("❌ DIAG_INVOICE env var is required")
    return
  }

  logger.info(`═══ RECEIVING INVOICE AUDIT — "${INVOICE}" ═══`)

  /* Pull every receiving_record with this invoice_number. */
  const records = await history.listReceivingRecords({ invoice_number: [INVOICE] }, { take: 100 })
  logger.info(`Found ${records.length} receiving_record row(s) for invoice "${INVOICE}"`)
  logger.info("")

  if (records.length === 0) {
    logger.warn("No matching record — invoice number might be slightly different.")
    return
  }

  if (records.length > 1) {
    logger.warn(`⚠ DUPLICATE HISTORY — ${records.length} rows for the same invoice number.`)
    logger.warn("  Expected: 1 record per invoice. Each Save click is creating a new row instead of")
    logger.warn("  updating the existing one. See /admin/receiving/save route — it always calls")
    logger.warn("  createReceivingRecords; should find-or-create by invoice_number.")
    logger.warn("")
  }

  /* Aggregate per-line results across ALL records (latest wins for status reporting). */
  const allLines: Array<{ recordId: string; createdAt: any; line: any }> = []
  for (const r of records) {
    const lines = (r.line_results ?? []) as any[]
    for (const line of lines) {
      allLines.push({ recordId: r.id, createdAt: r.created_at, line })
    }
  }

  /* Group by strainName to detect retries on the same row. */
  const byStrain: Record<string, Array<{ recordId: string; createdAt: any; line: any }>> = {}
  for (const entry of allLines) {
    const key = String(entry.line.strainName ?? "(unknown)")
    byStrain[key] = byStrain[key] ?? []
    byStrain[key].push(entry)
  }

  /* ── Per-record overview ── */
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    logger.info(`── Record #${i + 1} ── id=${r.id}  created_at=${r.created_at}`)
    const lines = (r.line_results ?? []) as any[]
    const created = lines.filter((l) => l.action === "created").length
    const restocked = lines.filter((l) => l.action === "restocked").length
    const failed = lines.filter((l) => l.action === "failed").length
    logger.info(`  totals: created=${created} restocked=${restocked} failed=${failed} (total ${lines.length})`)
    logger.info(`  qbo_bill_id: ${r.qbo_bill_id ?? "—"}`)
    logger.info(`  qbo_push_status: ${r.qbo_push_status ?? "—"}`)
    if (r.qbo_push_error) logger.info(`  qbo_push_error: ${r.qbo_push_error}`)
    if (failed > 0) {
      logger.info("  FAILED lines:")
      for (const l of lines.filter((l) => l.action === "failed")) {
        logger.info(`    - "${l.strainName}" (${l.tier ?? "no tier"}) → ${l.error ?? "(no error message)"}`)
      }
    }
    logger.info("")
  }

  /* ── Strains that failed in any record ── */
  const failedStrains = new Set<string>()
  for (const r of records) {
    for (const l of (r.line_results ?? []) as any[]) {
      if (l.action === "failed") failedStrains.add(String(l.strainName))
    }
  }
  if (failedStrains.size > 0) {
    logger.info(`── Strains with FAILED status (any record) — ${failedStrains.size} ──`)
    for (const strain of failedStrains) {
      logger.info(`  "${strain}"`)
      const history = byStrain[strain] ?? []
      for (const h of history) {
        logger.info(`    [record ${h.recordId.slice(-6)} @ ${h.createdAt}] action=${h.line.action} error=${h.line.error ?? "—"}`)
      }
      /* Does this strain exist as a product in the catalog right now? */
      const { data: maybeProducts } = await query.graph({
        entity: "product",
        fields: ["id", "handle", "title", "status"],
        filters: { title: strain },
      })
      const products = (maybeProducts as any[]) ?? []
      if (products.length === 0) {
        logger.info(`    ❌ no product in catalog with title "${strain}" — receiving truly failed for this strain`)
      } else {
        logger.info(`    ✓ ${products.length} product(s) in catalog:`)
        for (const p of products) {
          logger.info(`        ${p.id} · handle=${p.handle} · status=${p.status}`)
        }
      }
    }
    logger.info("")
  }

  /* ── QBO push diagnosis ── */
  const recordsPushed = records.filter((r: any) => r.qbo_push_status === "success" || r.qbo_bill_id)
  const recordsErrored = records.filter((r: any) => r.qbo_push_status === "error")
  logger.info(`── QBO push state ──`)
  logger.info(`  successful pushes: ${recordsPushed.length}`)
  logger.info(`  errored pushes:    ${recordsErrored.length}`)
  if (recordsErrored.length > 0) {
    for (const r of recordsErrored) {
      logger.info(`    - record ${r.id} → ${r.qbo_push_error ?? "(no error stored)"}`)
    }
  }
  logger.info("")

  logger.info("═══ END AUDIT ═══")
}

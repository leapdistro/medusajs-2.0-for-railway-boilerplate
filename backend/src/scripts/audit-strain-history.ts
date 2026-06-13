import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * Audit — for a given strain (by exact title), scan EVERY receiving
 * record and dump per-record contributions (action + qty + landed
 * cost) so we can reconcile the current stocked quantity against
 * what was actually received. Catches inventory drift bugs.
 *
 * Usage:
 *   DIAG_STRAIN='Lime Sherb' pnpm audit:strain-history
 */

const STRAIN = process.env.DIAG_STRAIN || ""

export default async function auditStrainHistory({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)

  if (!STRAIN) {
    logger.error("❌ DIAG_STRAIN env var required (e.g. 'Lime Sherb')")
    return
  }

  logger.info(`═══ AUDIT STRAIN HISTORY — "${STRAIN}" ═══`)

  /* Current catalog state. */
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "handle", "title",
      "variants.id", "variants.title",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.metadata",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
    ],
    filters: { title: STRAIN },
  })

  const matched = (products as any[]) ?? []
  if (matched.length === 0) {
    logger.warn(`No product in catalog with title "${STRAIN}". Continuing to scan history anyway.`)
  }
  for (const p of matched) {
    const inv = p.variants?.[0]?.inventory_items?.[0]?.inventory
    const lvl = (inv?.location_levels ?? [])[0]
    logger.info(`Catalog state: product=${p.id} handle=${p.handle}`)
    logger.info(`  inventory_item=${inv?.id}`)
    logger.info(`  landed_per_qp=$${Number(inv?.metadata?.landed_per_qp ?? 0).toFixed(4)}`)
    logger.info(`  stocked_quantity=${lvl?.stocked_quantity ?? "—"}  reserved=${lvl?.reserved_quantity ?? "—"}`)
  }
  logger.info("")

  /* Scan every receiving_record. */
  const all = await history.listReceivingRecords({}, { take: 1000 }).catch(() => [])
  logger.info(`Scanning ${all.length} receiving_record(s)…`)
  logger.info("")

  const hits: Array<{ recordId: string; invoiceNumber: string; createdAt: any; line: any }> = []
  for (const r of all) {
    for (const line of (r.line_results ?? []) as any[]) {
      if (String(line?.strainName ?? "").trim().toLowerCase() === STRAIN.trim().toLowerCase()) {
        hits.push({ recordId: r.id, invoiceNumber: r.invoice_number, createdAt: r.created_at, line })
      }
    }
  }

  if (hits.length === 0) {
    logger.warn(`No receiving_record line_results reference "${STRAIN}".`)
    logger.info("Possible explanations:")
    logger.info("  - Product was created outside the receiving flow (manual admin entry)")
    logger.info("  - line_results were never written (early failures)")
    logger.info("  - Strain title differs from receiving entry (try a variant casing or alias)")
    return
  }

  /* Sort chronologically. */
  hits.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  logger.info(`Found ${hits.length} line_result entry/entries for "${STRAIN}":`)
  logger.info("")

  let createdSum = 0
  let restockedSum = 0
  let failedCount = 0
  for (const h of hits) {
    const l = h.line
    const qty = Number(l.qtyQps ?? 0)
    const landed = Number(l.landedPerQp ?? 0)
    logger.info(`[${h.createdAt}]  invoice=${h.invoiceNumber}  record=${h.recordId.slice(-6)}`)
    logger.info(`    action=${l.action}  tier=${l.tier}  qty=${qty}QP  landed=$${landed.toFixed(4)}`)
    if (l.error) logger.info(`    error=${l.error}`)
    if (l.action === "created") createdSum += qty
    if (l.action === "restocked") restockedSum += qty
    if (l.action === "failed") failedCount += 1
  }

  const expectedStock = createdSum + restockedSum
  logger.info("")
  logger.info(`── Sum from receiving_record entries ──`)
  logger.info(`  created entries (qty sum): ${createdSum} QP`)
  logger.info(`  restocked entries (qty sum): ${restockedSum} QP`)
  logger.info(`  failed entries (count):    ${failedCount}`)
  logger.info(`  EXPECTED current stock:    ${expectedStock} QP`)

  for (const p of matched) {
    const inv = p.variants?.[0]?.inventory_items?.[0]?.inventory
    const lvl = (inv?.location_levels ?? [])[0]
    const actual = Number(lvl?.stocked_quantity ?? 0)
    const drift = actual - expectedStock
    logger.info(`  ACTUAL stocked_quantity:   ${actual} QP`)
    logger.info(`  DRIFT (actual − expected): ${drift > 0 ? "+" + drift : drift} QP`)
    if (drift !== 0) {
      logger.warn(`  ⚠ Drift detected. Possible causes:`)
      logger.warn(`    - Inventory writes from a non-receiving path (manual admin edit, seed script)`)
      logger.warn(`    - Reconstruction-script qty echoed an EXISTING stock, but record was retroactively merged with a successful-restock entry (double-count)`)
      logger.warn(`    - Receiving wrote inventory but the line_result was lost (find-or-create REPLACE before merge fix)`)
    }
  }

  logger.info("═══ END ═══")
}

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * One-off cleanup — for a given invoice_number, keep the OLDEST
 * receiving_record (the one with real created/restocked counts) and
 * delete the rest.
 *
 * Use case: before the find-or-create fix shipped, every retry-Save
 * inserted a new history row. Audits surface them; this wipes them.
 *
 * Usage:
 *   DIAG_INVOICE=20260605-093116945 pnpm wipe:duplicate-receivings
 */

const INVOICE = process.env.DIAG_INVOICE || ""

export default async function wipeDuplicateReceivings({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)

  if (!INVOICE) {
    logger.error("❌ DIAG_INVOICE env var is required")
    return
  }

  const records = await history.listReceivingRecords(
    { invoice_number: [INVOICE] },
    { take: 100 },
  )
  if (records.length === 0) {
    logger.info(`No records for invoice "${INVOICE}".`)
    return
  }
  if (records.length === 1) {
    logger.info(`Only 1 record for invoice "${INVOICE}" — nothing to clean.`)
    return
  }

  /* Sort ascending by created_at, keep the oldest. */
  records.sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  const keep = records[0]
  const drop = records.slice(1)

  logger.info(`Invoice "${INVOICE}": keeping oldest record ${keep.id} (${keep.created_at})`)
  logger.info(`Dropping ${drop.length} duplicate(s):`)
  for (const r of drop) logger.info(`  - ${r.id} (${r.created_at})`)

  await history.deleteReceivingRecords(drop.map((r: any) => r.id))
  logger.info(`✓ Deleted ${drop.length} duplicates.`)
}

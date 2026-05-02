import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { RECEIVING_HISTORY_MODULE } from "../../../../modules/receiving-history"

/**
 * GET /admin/receiving/history
 *
 * Returns every receiving record, newest first. The history list page
 * renders this as a table — supplier, invoice #, date, line count,
 * totals, status. Detail rows fetched on-demand via /:id.
 *
 * Returns full record objects (including line_results) — not paginated
 * yet. With ~few hundred receivings/year for one supplier, list-all
 * fits comfortably; revisit when the table approaches a few thousand.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)
  const records = await history.listReceivingRecords(
    {},
    { order: { created_at: "DESC" } },
  )
  res.json({ records, count: records.length })
}

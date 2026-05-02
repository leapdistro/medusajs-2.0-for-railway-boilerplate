import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { RECEIVING_HISTORY_MODULE } from "../../../../../modules/receiving-history"

/**
 * GET /admin/receiving/history/[id] — full record for the detail view.
 * Includes line_results (full per-row outcome from saveOneRow).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params as { id: string }
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)
  const record = await history.retrieveReceivingRecord(id).catch(() => null)
  if (!record) {
    res.status(404).json({ ok: false, message: "Not found" })
    return
  }
  res.json({ record })
}

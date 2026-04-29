import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { RECEIVING_DRAFTS_MODULE } from "../../../../modules/receiving-drafts"

/**
 * Receiving drafts collection endpoints.
 *
 *   GET  /admin/receiving/drafts              → list all drafts (newest first)
 *   POST /admin/receiving/drafts              → create — body { payload, summary }
 *
 * Drafts are operator-private only by convention here — there's no
 * tenant/user filter, since the admin auth boundary is the only gate
 * we need for an internal tool. Single-store, small team.
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const drafts: any = req.scope.resolve(RECEIVING_DRAFTS_MODULE)
  const rows = await drafts.listReceivingDrafts({}, { order: { updated_at: "DESC" } })
  res.json({ drafts: rows })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { payload?: unknown; summary?: unknown }
  if (body.payload === undefined) {
    res.status(400).json({ ok: false, message: "payload is required" })
    return
  }
  const drafts: any = req.scope.resolve(RECEIVING_DRAFTS_MODULE)
  const [row] = await drafts.createReceivingDrafts([
    { payload: body.payload, summary: body.summary ?? {} },
  ])
  res.json({ ok: true, draft: row })
}

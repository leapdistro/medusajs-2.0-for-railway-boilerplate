import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { RECEIVING_DRAFTS_MODULE } from "../../../../../modules/receiving-drafts"

/**
 * Single-draft endpoints — fetch, update, delete.
 *
 *   GET    /admin/receiving/drafts/:id   → load full payload (for resume)
 *   PATCH  /admin/receiving/drafts/:id   → update — body { payload, summary }
 *   DELETE /admin/receiving/drafts/:id   → discard
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params as { id: string }
  const drafts: any = req.scope.resolve(RECEIVING_DRAFTS_MODULE)
  const row = await drafts.retrieveReceivingDraft(id).catch(() => null)
  if (!row) {
    res.status(404).json({ ok: false, message: "Not found" })
    return
  }
  res.json({ draft: row })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  /* PATCH-style update — accepts POST too because some HTTP clients
   * (and Medusa's admin fetch helper) don't expose PATCH cleanly. */
  return PATCH(req, res)
}

export const PATCH = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as { payload?: unknown; summary?: unknown }
  if (body.payload === undefined && body.summary === undefined) {
    res.status(400).json({ ok: false, message: "payload or summary is required" })
    return
  }
  const drafts: any = req.scope.resolve(RECEIVING_DRAFTS_MODULE)
  const patch: any = { id }
  if (body.payload !== undefined) patch.payload = body.payload
  if (body.summary !== undefined) patch.summary = body.summary
  const [row] = await drafts.updateReceivingDrafts([patch])
  res.json({ ok: true, draft: row })
}

export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id } = req.params as { id: string }
  const drafts: any = req.scope.resolve(RECEIVING_DRAFTS_MODULE)
  await drafts.deleteReceivingDrafts([id])
  res.json({ ok: true })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { serializeCampaign, upsertReceivingDraft } from "../../../../../lib/marketing/campaigns"

/**
 * POST /admin/marketing/from-receiving/:id
 * "Announce to customers": the announcement draft for that receiving,
 * built from the receiving template (lib/marketing/campaigns.ts). If one
 * was already made (automatically on save, or by an earlier click) it's
 * returned instead of a second one. Nothing is sent.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const r = await upsertReceivingDraft(req.scope, req.params.id, { auto: false, actorId: (req as any).auth_context?.actor_id ?? null })
  if (!r.campaign) return res.status(400).json({ message: r.reason ?? "Nothing to announce." })
  res.json({ campaign: serializeCampaign(r.campaign) })
}

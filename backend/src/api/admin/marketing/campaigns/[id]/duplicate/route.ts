import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../../modules/marketing"
import { serializeCampaign } from "../../../../../../lib/marketing/campaigns"

/** POST /admin/marketing/campaigns/:id/duplicate — a new draft with the same content and audience. */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  const copy = await marketing.createMarketingCampaigns({
    name: `${c.name} (copy)`.slice(0, 120), subject: c.subject, preheader: c.preheader,
    blocks: c.blocks, audience: c.audience, status: "draft", source: c.source,
    created_by: (req as any).auth_context?.actor_id ?? null,
  })
  res.json({ campaign: serializeCampaign(copy) })
}

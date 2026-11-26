import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../modules/marketing"
import { EMPTY_AUDIENCE, sanitizeBlocks } from "../../../../lib/marketing/blocks"
import { builtinReceivingTemplate, serializeCampaign } from "../../../../lib/marketing/campaigns"

/**
 * POST /admin/marketing/templates  Body: { fromCampaignId? }
 * "Save as template" (copies a campaign's content and audience) or, with
 * no campaign, a new template starting from the built-in receiving one.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const body = (req.body ?? {}) as Record<string, unknown>
  let base: any
  if (typeof body.fromCampaignId === "string" && body.fromCampaignId) {
    const c = await marketing.retrieveMarketingCampaign(body.fromCampaignId).catch(() => null)
    if (!c) return res.status(404).json({ message: "Campaign not found." })
    base = { name: `${c.name.replace(/\s+\d{4}-\d{2}-\d{2}$/, "")} template`, subject: c.subject, preheader: c.preheader, audience: c.audience, blocks: sanitizeBlocks(c.blocks) }
  } else {
    const b = builtinReceivingTemplate()
    base = { name: "Receiving announcement", subject: b.subject, preheader: b.preheader, audience: b.audience, blocks: b.blocks }
  }
  const created = await marketing.createMarketingCampaigns({
    name: String(base.name).slice(0, 120), subject: base.subject ?? "", preheader: base.preheader ?? "",
    audience: base.audience ?? EMPTY_AUDIENCE, blocks: base.blocks, status: "template", template_role: null,
    created_by: (req as any).auth_context?.actor_id ?? null,
  })
  res.json({ campaign: serializeCampaign(created) })
}

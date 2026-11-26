import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../modules/marketing"
import { EMPTY_AUDIENCE, sanitizeBlocks } from "../../../../lib/marketing/blocks"
import { applyTemplate, serializeCampaign, starterBlocks, sendingSetup } from "../../../../lib/marketing/campaigns"

/**
 * GET /admin/marketing/campaigns — campaigns (newest first) and saved
 * templates, separately.
 * POST — new draft; body { name?, templateId? }. From a template: its
 * subject, preview line, audience and blocks (fill-from-receiving
 * products blocks become empty picks).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const rows = (await marketing.listMarketingCampaigns({}, { take: 300, order: { created_at: "DESC" } })) as any[]
  res.json({
    campaigns: rows.filter((c) => c.status !== "template").map(serializeCampaign),
    templates: rows.filter((c) => c.status === "template").map(serializeCampaign),
    sending: sendingSetup(),
  })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const body = (req.body ?? {}) as Record<string, unknown>
  const actor = (req as any).auth_context?.actor_id ?? null
  if (typeof body.templateId === "string" && body.templateId) {
    const t = await marketing.retrieveMarketingCampaign(body.templateId).catch(() => null)
    if (!t || t.status !== "template") return res.status(404).json({ message: "Template not found." })
    const created = await marketing.createMarketingCampaigns({
      name: `${t.name} ${new Date().toISOString().slice(0, 10)}`.slice(0, 120),
      subject: t.subject, preheader: t.preheader, audience: t.audience ?? EMPTY_AUDIENCE,
      blocks: applyTemplate(sanitizeBlocks(t.blocks), null, null), status: "draft",
      source: { type: "template", id: t.id }, created_by: actor,
    })
    return res.json({ campaign: serializeCampaign(created) })
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `Campaign ${new Date().toISOString().slice(0, 10)}`
  const created = await marketing.createMarketingCampaigns({
    name, subject: "", preheader: "", blocks: starterBlocks(), audience: EMPTY_AUDIENCE, status: "draft", created_by: actor,
  })
  res.json({ campaign: serializeCampaign(created) })
}

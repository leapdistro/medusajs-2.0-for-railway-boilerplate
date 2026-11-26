import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../modules/marketing"
import { EMPTY_AUDIENCE } from "../../../../lib/marketing/blocks"
import { serializeCampaign, starterBlocks, sendingSetup } from "../../../../lib/marketing/campaigns"

/** GET /admin/marketing/campaigns — newest first.
 *  POST — new draft with starter content; body { name? }. */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const rows = await marketing.listMarketingCampaigns({}, { take: 200, order: { created_at: "DESC" } })
  res.json({ campaigns: (rows as any[]).map(serializeCampaign), sending: sendingSetup() })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const body = (req.body ?? {}) as Record<string, unknown>
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `Campaign ${new Date().toISOString().slice(0, 10)}`
  const created = await marketing.createMarketingCampaigns({
    name, subject: "", preheader: "", blocks: starterBlocks(), audience: EMPTY_AUDIENCE, status: "draft",
    created_by: (req as any).auth_context?.actor_id ?? null,
  })
  res.json({ campaign: serializeCampaign(created) })
}

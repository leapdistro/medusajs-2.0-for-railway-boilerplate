import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../../modules/marketing"

/**
 * POST /admin/marketing/campaigns/:id/cancel
 * Scheduled → back to draft (editable). Sending → stops after the batch
 * in flight; already-sent emails can't be recalled.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  if (c.status === "scheduled") {
    await marketing.updateMarketingCampaigns({ id: c.id, status: "draft", scheduled_at: null })
    return res.json({ ok: true, status: "draft" })
  }
  if (c.status === "sending") {
    await marketing.updateMarketingCampaigns({ id: c.id, status: "cancelled", last_error: "Stopped by admin." })
    const queued = (await marketing.listMarketingRecipients({ campaign_id: c.id, status: "queued" }, { take: 100000, select: ["id"] })) as any[]
    if (queued.length) await marketing.updateMarketingRecipients(queued.map((r) => ({ id: r.id, status: "skipped", error: "Campaign stopped" })))
    return res.json({ ok: true, status: "cancelled", notSent: queued.length })
  }
  res.status(409).json({ message: `Nothing to cancel: this campaign is ${c.status}.` })
}

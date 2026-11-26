import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../modules/marketing"
import { sanitizeAudience, sanitizeBlocks } from "../../../../../lib/marketing/blocks"
import { sendProblems, sendingSetup, serializeCampaign } from "../../../../../lib/marketing/campaigns"

const EDITABLE = ["draft", "template"]

/** GET: campaign + recipient tallies + sending setup.
 *  POST: save edits (drafts and templates); body { name?, subject?,
 *  preheader?, blocks?, audience?, template_role? (templates: "receiving"
 *  or null; only one template holds a role) }.
 *  DELETE: drafts, templates and stopped campaigns only. */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  const campaign = serializeCampaign(c)
  let tallies: Record<string, number> = {}
  let failures: Array<{ email: string; error: string }> = []
  if (c.status !== "draft" && c.status !== "scheduled") {
    const rows = (await marketing.listMarketingRecipients({ campaign_id: c.id }, { take: 100000, select: ["email", "status", "error"] })) as any[]
    for (const r of rows) tallies[r.status] = (tallies[r.status] ?? 0) + 1
    failures = rows.filter((r) => r.status === "failed" || r.status === "skipped").slice(0, 50).map((r) => ({ email: r.email, error: r.error ?? r.status }))
  }
  res.json({ campaign, tallies, failures, problems: c.status === "template" ? [] : sendProblems(campaign), sending: sendingSetup() })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  if (!EDITABLE.includes(c.status)) {
    return res.status(409).json({ message: c.status === "scheduled" ? "Unschedule it first to edit." : "This campaign has been sent and can't be edited. Duplicate it instead." })
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = { id: c.id }
  if (typeof b.name === "string") patch.name = b.name.trim().slice(0, 120) || c.name
  if (typeof b.subject === "string") patch.subject = b.subject.slice(0, 200)
  if (typeof b.preheader === "string") patch.preheader = b.preheader.slice(0, 200)
  if (b.blocks !== undefined) patch.blocks = sanitizeBlocks(b.blocks)
  if (b.audience !== undefined) patch.audience = sanitizeAudience(b.audience)
  if (c.status === "template" && b.template_role !== undefined) {
    const role = b.template_role === "receiving" ? "receiving" : null
    if (role) {
      const holders = (await marketing.listMarketingCampaigns({ status: "template", template_role: role }, { take: 50 })) as any[]
      for (const h of holders) if (h.id !== c.id) await marketing.updateMarketingCampaigns({ id: h.id, template_role: null })
    }
    patch.template_role = role
  }
  /* An auto-made receiving draft the admin has touched is theirs now:
   * a later save of the same receiving won't overwrite it. */
  if (c.status === "draft" && c.source?.type === "receiving" && !c.source?.edited &&
      (b.blocks !== undefined || typeof b.subject === "string" || typeof b.preheader === "string" || b.audience !== undefined)) {
    patch.source = { ...c.source, edited: true }
  }
  const saved = await marketing.updateMarketingCampaigns(patch)
  const campaign = serializeCampaign(saved)
  res.json({ campaign, problems: saved.status === "template" ? [] : sendProblems(campaign) })
}

export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  if (c.status !== "draft" && c.status !== "cancelled" && c.status !== "template") {
    return res.status(409).json({ message: "Only drafts and templates can be deleted. Sent campaigns stay for the record." })
  }
  await marketing.softDeleteMarketingCampaigns([c.id])
  res.json({ ok: true })
}

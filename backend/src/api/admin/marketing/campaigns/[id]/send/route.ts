import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MARKETING_MODULE } from "../../../../../../modules/marketing"
import { resolveAudience } from "../../../../../../lib/marketing/audience"
import { sanitizeAudience, sanitizeBlocks } from "../../../../../../lib/marketing/blocks"
import { sendProblems } from "../../../../../../lib/marketing/campaigns"
import { processCampaign, queueCampaign } from "../../../../../../lib/marketing/send"
import { senderStatus } from "../../../../../../lib/marketing/sender"

/**
 * POST /admin/marketing/campaigns/:id/send
 * Body: { confirmCount: number, scheduledAt?: ISO string }
 *
 * The admin types the number of recipients to confirm (owner,
 * 2026-11-25). It must equal the live audience count right now, so a
 * stale screen can't send to more people than were shown. Sends now, or
 * schedules (the marketing-send job starts it at that time and the list
 * is fixed then).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  if (c.status !== "draft") return res.status(409).json({ message: `This campaign is ${c.status}.` })

  const st = senderStatus()
  if (!st.ready) return res.status(400).json({ message: st.reason })
  const problems = sendProblems({ subject: c.subject, blocks: sanitizeBlocks(c.blocks) })
  if (problems.length) return res.status(400).json({ message: problems.join(" ") })

  const b = (req.body ?? {}) as Record<string, unknown>
  const { recipients } = await resolveAudience(req.scope, sanitizeAudience(c.audience))
  if (!recipients.length) return res.status(400).json({ message: "No one matches this audience." })
  if (Number(b.confirmCount) !== recipients.length) {
    return res.status(409).json({ message: `The audience is now ${recipients.length} people. Check it and type that number.`, count: recipients.length })
  }

  if (typeof b.scheduledAt === "string" && b.scheduledAt) {
    const at = new Date(b.scheduledAt)
    if (Number.isNaN(at.getTime())) return res.status(400).json({ message: "That date doesn't look right." })
    if (at.getTime() > Date.now() + 60_000) {
      const saved = await marketing.updateMarketingCampaigns({ id: c.id, status: "scheduled", scheduled_at: at.toISOString(), recipient_count: recipients.length })
      return res.json({ ok: true, status: saved.status, scheduled_at: saved.scheduled_at })
    }
  }

  const { queued } = await queueCampaign(req.scope, c.id)
  const log = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m), error: (m: string) => logger.error(m) }
  void processCampaign(req.scope, c.id, log)
  res.json({ ok: true, status: "sending", queued })
}

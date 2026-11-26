import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../modules/marketing"
import { readUnsubscribeToken } from "../../../../../lib/marketing/unsubscribe"

/**
 * POST /store/mbs/marketing/unsubscribe  Body: { t }
 * Adds the token's address to the suppression list (idempotent). Used by
 * the storefront's /unsubscribe page and its one-click endpoint. Only
 * marketing email stops; order and account email are unaffected.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = readUnsubscribeToken((req.body as any)?.t)
  if (!parsed) return res.status(400).json({ ok: false, message: "This unsubscribe link isn't valid." })
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const [existing] = await marketing.listMarketingSuppressions({ email: parsed.email }, { take: 1 })
  if (!existing) {
    await marketing.createMarketingSuppressions({ email: parsed.email, reason: "unsubscribed", campaign_id: parsed.campaignId })
  }
  const [user, domain] = parsed.email.split("@")
  res.json({ ok: true, email: `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}` })
}

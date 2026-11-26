import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../../modules/marketing"
import { approvedContacts } from "../../../../../../lib/marketing/audience"
import { productIdsOf, sanitizeBlocks } from "../../../../../../lib/marketing/blocks"
import { renderMarketingEmail } from "../../../../../../lib/marketing/email"
import { loadEmailProducts, searchProducts } from "../../../../../../lib/marketing/products"
import { applyTemplate, fillTokens } from "../../../../../../lib/marketing/campaigns"

/**
 * POST /admin/marketing/campaigns/:id/preview
 * Body: { subject, preheader, blocks, viewAs? (customer id) }
 * Renders the unsaved editor content exactly as it would be sent, priced
 * for `viewAs` (default prices when none). Also lists picked products
 * that would be left out (sold out / unpublished / deleted).
 * A template has no receiving yet: its fill-from-receiving blocks show
 * the newest in-stock products and the receiving words sample counts.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  const b = (req.body ?? {}) as Record<string, unknown>
  let blocks = b.blocks !== undefined ? sanitizeBlocks(b.blocks) : sanitizeBlocks(c.blocks)
  let subject = typeof b.subject === "string" ? b.subject : c.subject
  let preheader = typeof b.preheader === "string" ? b.preheader : c.preheader
  if (c.status === "template") {
    const newest = (await searchProducts(req.scope, "", 40)).filter((p) => p.inStock).map((p) => p.id)
    const sample = { newCount: 23, restockCount: 9 }
    blocks = applyTemplate(blocks, { new: newest.slice(0, 24), restock: newest.slice(24) }, sample)
    subject = fillTokens(subject, sample)
    preheader = fillTokens(preheader, sample)
  }
  const ids = productIdsOf(blocks)

  let groupIds: string[] = []
  let contact: { firstName: string; company: string } | null = null
  if (typeof b.viewAs === "string" && b.viewAs) {
    const found = (await approvedContacts(req.scope)).find((x) => x.customerId === b.viewAs)
    if (found) {
      groupIds = found.groupIds
      contact = { firstName: found.firstName, company: found.company }
    }
  }
  const all = await loadEmailProducts(req.scope, ids, groupIds, { includeUnavailable: true })
  const live = new Map([...all].filter(([, p]) => p.inStock))
  const unavailable = ids.filter((id) => !live.has(id)).map((id) => ({ id, title: all.get(id)?.title ?? "Deleted product" }))

  const { html } = await renderMarketingEmail({
    campaignId: c.id,
    subject,
    preheader,
    blocks,
    products: live,
    contact,
    unsubscribeUrl: null,
  })
  res.set("Cache-Control", "no-store")
  res.json({ html, unavailable, subject, preheader })
}

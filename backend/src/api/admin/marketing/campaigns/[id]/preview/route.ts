import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../../modules/marketing"
import { approvedContacts } from "../../../../../../lib/marketing/audience"
import { productIdsOf, sanitizeBlocks } from "../../../../../../lib/marketing/blocks"
import { renderMarketingEmail } from "../../../../../../lib/marketing/email"
import { loadEmailProducts } from "../../../../../../lib/marketing/products"

/**
 * POST /admin/marketing/campaigns/:id/preview
 * Body: { subject, preheader, blocks, viewAs? (customer id) }
 * Renders the unsaved editor content exactly as it would be sent, priced
 * for `viewAs` (default prices when none). Also lists picked products
 * that would be left out (sold out / unpublished / deleted).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  const b = (req.body ?? {}) as Record<string, unknown>
  const blocks = b.blocks !== undefined ? sanitizeBlocks(b.blocks) : sanitizeBlocks(c.blocks)
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
    subject: typeof b.subject === "string" ? b.subject : c.subject,
    preheader: typeof b.preheader === "string" ? b.preheader : c.preheader,
    blocks,
    products: live,
    contact,
    unsubscribeUrl: null,
  })
  res.set("Cache-Control", "no-store")
  res.json({ html, unavailable })
}

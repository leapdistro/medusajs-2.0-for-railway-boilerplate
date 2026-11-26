import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../modules/marketing"
import { RECEIVING_HISTORY_MODULE } from "../../../../../modules/receiving-history"
import { EMPTY_AUDIENCE } from "../../../../../lib/marketing/blocks"
import { receivingDraft, serializeCampaign } from "../../../../../lib/marketing/campaigns"

/**
 * POST /admin/marketing/from-receiving/:id
 * "Announce this receiving": a new draft featuring a varied handful of
 * that receiving's products (lib/marketing/campaigns.ts receivingDraft)
 * and a "See all" button to the site. Nothing is sent; the admin edits,
 * previews and sends from the editor.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const record = await history.retrieveReceivingRecord(req.params.id).catch(() => null)
  if (!record) return res.status(404).json({ message: "Receiving not found." })
  const draft = await receivingDraft(req.scope, record)
  if (!draft.blocks.some((b) => b.type === "products")) {
    return res.status(400).json({ message: "None of this receiving's products are live and in stock right now, so there's nothing to announce." })
  }
  const created = await marketing.createMarketingCampaigns({
    name: draft.name, subject: draft.subject, preheader: "", blocks: draft.blocks, audience: EMPTY_AUDIENCE, status: "draft",
    source: { type: "receiving", id: record.id, invoice: record.invoice_number ?? null, ...draft.counts },
    created_by: (req as any).auth_context?.actor_id ?? null,
  })
  res.json({ campaign: serializeCampaign(created) })
}

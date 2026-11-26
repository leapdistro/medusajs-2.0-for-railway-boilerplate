import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MARKETING_MODULE } from "../../../../../../modules/marketing"
import { approvedContacts } from "../../../../../../lib/marketing/audience"
import { productIdsOf, sanitizeBlocks } from "../../../../../../lib/marketing/blocks"
import { sendProblems } from "../../../../../../lib/marketing/campaigns"
import { loadEmailProducts } from "../../../../../../lib/marketing/products"
import { renderForContact } from "../../../../../../lib/marketing/send"
import { marketingSender, senderStatus } from "../../../../../../lib/marketing/sender"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * POST /admin/marketing/campaigns/:id/test
 * Body: { to: string[] (max 5), viewAs?: customer id }
 * Sends the saved campaign to the given addresses, subject prefixed
 * "[Test]", priced as `viewAs`. Customers never get it.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const marketing: any = req.scope.resolve(MARKETING_MODULE)
  const c = await marketing.retrieveMarketingCampaign(req.params.id).catch(() => null)
  if (!c) return res.status(404).json({ message: "Campaign not found." })
  const b = (req.body ?? {}) as Record<string, unknown>
  const to = (Array.isArray(b.to) ? b.to : [])
    .map((x) => String(x).trim().toLowerCase()).filter((x) => EMAIL.test(x))
  if (!to.length) return res.status(400).json({ message: "Enter an email address to send the test to." })
  if (to.length > 5) return res.status(400).json({ message: "Five test addresses at most." })

  const st = senderStatus()
  const sender = marketingSender()
  if (!sender) return res.status(400).json({ message: st.reason })

  const content = { id: c.id, subject: c.subject, preheader: c.preheader, blocks: sanitizeBlocks(c.blocks) }
  const problems = sendProblems(content)
  if (problems.length) return res.status(400).json({ message: problems.join(" ") })

  let groupIds: string[] = []
  let contact: { firstName: string; company: string } | null = null
  if (typeof b.viewAs === "string" && b.viewAs) {
    const found = (await approvedContacts(req.scope)).find((x) => x.customerId === b.viewAs)
    if (found) { groupIds = found.groupIds; contact = { firstName: found.firstName, company: found.company } }
  }
  const products = await loadEmailProducts(req.scope, productIdsOf(content.blocks), groupIds)
  const emails = []
  for (const addr of to) {
    const r = await renderForContact(content, products, contact, addr)
    emails.push({ to: addr, subject: `[Test] ${c.subject}`, html: r.html, text: r.text, headers: r.headers, tags: [{ name: "campaign", value: "test" }] })
  }
  const results = await sender.sendBatch(emails)
  const failed = results.filter((r) => !r.id)
  if (failed.length) return res.status(502).json({ message: `Test didn't send: ${failed[0].error}` })
  await marketing.updateMarketingCampaigns({ id: c.id, last_test_at: new Date().toISOString() })
  res.json({ ok: true, sentTo: to })
}

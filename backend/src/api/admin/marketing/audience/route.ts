import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { approvedContacts, audienceOptions, matchesAudience, suppressedEmails } from "../../../../lib/marketing/audience"
import { sanitizeAudience } from "../../../../lib/marketing/blocks"

/**
 * POST /admin/marketing/audience  Body: { audience }
 * Live count for the audience picker: who'd get it, who's left out for
 * having unsubscribed / bounced, and the filter choices with counts.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const audience = sanitizeAudience((req.body as any)?.audience)
  const [contacts, suppressed] = await Promise.all([approvedContacts(req.scope), suppressedEmails(req.scope)])
  const matched = contacts.filter((c) => matchesAudience(c, audience))
  const blocked = matched.filter((c) => suppressed.has(c.email))
  res.json({
    count: matched.length - blocked.length,
    suppressed: blocked.map((c) => ({ email: c.email, company: c.company, reason: suppressed.get(c.email) })),
    approvedTotal: contacts.length,
    options: audienceOptions(contacts),
  })
}

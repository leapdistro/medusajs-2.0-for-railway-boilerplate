import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { approvedContacts, PRICING_MODE_LABELS, suppressedEmails } from "../../../../lib/marketing/audience"

/** GET /admin/marketing/customers — approved customers for the
 *  hand-pick list and the preview's "View as". */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const [contacts, suppressed] = await Promise.all([approvedContacts(req.scope), suppressedEmails(req.scope)])
  res.json({
    customers: contacts
      .map((c) => ({
        id: c.customerId,
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        company: c.company,
        pricingMode: c.pricingMode,
        pricingLabel: PRICING_MODE_LABELS[c.pricingMode] ?? c.pricingMode,
        state: c.state,
        businessType: c.businessType,
        suppressed: suppressed.get(c.email) ?? null,
      }))
      .sort((a, b) => (a.company || a.email).localeCompare(b.company || b.email)),
  })
}

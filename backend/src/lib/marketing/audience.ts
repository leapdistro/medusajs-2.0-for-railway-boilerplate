import { Modules } from "@medusajs/framework/utils"
import { MARKETING_MODULE } from "../../modules/marketing"
import type { Audience } from "./blocks"

/**
 * Resolves who a campaign goes to: approved customers (members of the
 * "approved" group), narrowed by the campaign's audience, minus the
 * suppression list. Read live each time, so the count the admin sees is
 * the list that gets queued when they press Send.
 */

const APPROVED_GROUP_NAME = (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

export type Contact = {
  customerId: string
  email: string
  firstName: string
  lastName: string
  company: string
  groupIds: string[]
  pricingMode: string
  state: string
  businessType: string
}

export const PRICING_MODE_LABELS: Record<string, string> = {
  default: "Default",
  tier_2: "Chain of Stores",
  tier_3: "Low Volume",
  distro: "Distro",
  owner_stores: "Owner Stores",
  cbd_cbg: "CBD / CBG",
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Every approved customer with an email, as a Contact. */
export async function approvedContacts(scope: any): Promise<Contact[]> {
  const customers: any = scope.resolve(Modules.CUSTOMER)
  const groups = await customers.listCustomerGroups({}, { take: 500 })
  const approved = (groups as any[]).find((g) => String(g?.name ?? "").toLowerCase() === APPROVED_GROUP_NAME)
  if (!approved) return []

  const out: Contact[] = []
  const pageSize = 500
  for (let skip = 0; ; skip += pageSize) {
    const page = await customers.listCustomers({}, { take: pageSize, skip, relations: ["groups"], order: { created_at: "ASC" } })
    for (const c of page as any[]) {
      const groupIds = ((c.groups ?? []) as any[]).map((g) => g?.id).filter(Boolean)
      if (!groupIds.includes(approved.id)) continue
      const email = text(c.email).toLowerCase()
      if (!email || !email.includes("@")) continue
      const m = (c.metadata ?? {}) as Record<string, unknown>
      out.push({
        customerId: c.id,
        email,
        firstName: text(c.first_name),
        lastName: text(c.last_name),
        company: text(c.company_name) || text(m.business_name),
        groupIds: groupIds.sort(),
        pricingMode: text(m.pricing_mode) || "default",
        state: text(m.state).toUpperCase(),
        businessType: text(m.business_type_label),
      })
    }
    if ((page as any[]).length < pageSize) break
  }
  return out
}

export async function suppressedEmails(scope: any): Promise<Map<string, string>> {
  const marketing: any = scope.resolve(MARKETING_MODULE)
  const rows = await marketing.listMarketingSuppressions({}, { take: 100000, select: ["email", "reason"] })
  return new Map((rows as any[]).map((r) => [String(r.email).toLowerCase(), String(r.reason)]))
}

export function matchesAudience(c: Contact, a: Audience): boolean {
  if (a.exclude.includes(c.customerId)) return false
  if (a.mode === "pick") return a.customerIds.includes(c.customerId)
  if (a.mode === "filter") {
    if (a.pricingModes.length && !a.pricingModes.includes(c.pricingMode)) return false
    if (a.states.length && !a.states.includes(c.state)) return false
    if (a.businessTypes.length && !a.businessTypes.includes(c.businessType)) return false
  }
  return true
}

export type ResolvedAudience = {
  recipients: Contact[]
  /** Matched the audience but are on the suppression list. */
  suppressed: Array<{ email: string; reason: string }>
  /** All approved customers (for "142 of 160"). */
  approvedTotal: number
}

export async function resolveAudience(scope: any, audience: Audience): Promise<ResolvedAudience> {
  const [contacts, suppressed] = await Promise.all([approvedContacts(scope), suppressedEmails(scope)])
  const recipients: Contact[] = []
  const skipped: Array<{ email: string; reason: string }> = []
  const seen = new Set<string>()
  for (const c of contacts) {
    if (!matchesAudience(c, audience) || seen.has(c.email)) continue
    seen.add(c.email)
    const reason = suppressed.get(c.email)
    if (reason) skipped.push({ email: c.email, reason })
    else recipients.push(c)
  }
  return { recipients, suppressed: skipped, approvedTotal: contacts.length }
}

/** Filter choices for the audience picker, with counts. */
export function audienceOptions(contacts: Contact[]) {
  const count = (key: (c: Contact) => string) => {
    const m = new Map<string, number>()
    for (const c of contacts) {
      const k = key(c)
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, n]) => ({ value, count: n }))
  }
  return {
    pricingModes: count((c) => c.pricingMode).map((o) => ({ ...o, label: PRICING_MODE_LABELS[o.value] ?? o.value })),
    states: count((c) => c.state),
    businessTypes: count((c) => c.businessType),
  }
}

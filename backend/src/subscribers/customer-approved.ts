import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

const APPROVED_GROUP_NAME = (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

/**
 * When admin attaches a customer to the "approved" customer group, trigger
 * Medusa's reset-password flow so the customer gets a "Welcome — set your
 * password" email automatically.
 *
 * The reset call fires `auth.password_reset`, which the
 * customer-password-reset subscriber catches + emails. We pass
 * `context.isWelcome=true` through the trigger so that subscriber knows to
 * send the welcome variant of the copy.
 *
 * Why this approach: applicants got an auth identity at /apply time with a
 * random password they never see. Reusing the standard reset-password flow
 * means we get the token plumbing + Medusa's expiry handling for free.
 */
export default async function customerApprovedHandler({
  event,
  container,
}: SubscriberArgs<{ id: string; customer_ids?: string[] }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const data = event?.data ?? ({} as { id?: string; customer_ids?: string[] })

  const groupId = data.id
  const customerIds = data.customer_ids ?? []
  if (!groupId || customerIds.length === 0) return

  const customerService: any = container.resolve(Modules.CUSTOMER)

  // Resolve the group name to confirm this is the approved group.
  let groupName = ""
  try {
    const group = await customerService.retrieveCustomerGroup(groupId)
    groupName = String(group?.name ?? "").toLowerCase()
  } catch (e: any) {
    logger.warn(`[customer-approved] could not resolve group ${groupId}: ${e?.message}`)
    return
  }
  if (groupName !== APPROVED_GROUP_NAME) return

  // Look up the affected customers' emails (resolveCustomerGroup doesn't
  // hand us the email directly).
  let customers: Array<{ id: string; email: string }> = []
  try {
    customers = await customerService.listCustomers({ id: customerIds }, { take: customerIds.length })
  } catch (e: any) {
    logger.warn(`[customer-approved] could not list customers: ${e?.message}`)
    return
  }

  const baseUrl = process.env.MEDUSA_BACKEND_URL || `http://localhost:${process.env.PORT || 9000}`
  const publishableKey = process.env.MEDUSA_PUBLISHABLE_API_KEY

  for (const customer of customers) {
    if (!customer.email) continue
    try {
      // Trigger Medusa's standard reset flow. This fires auth.password_reset
      // which the password-reset subscriber catches and emails.
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (publishableKey) headers["x-publishable-api-key"] = publishableKey
      const res = await fetch(`${baseUrl}/auth/customer/emailpass/reset-password`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          identifier: customer.email,
          context: { isWelcome: true },
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        logger.warn(`[customer-approved] reset-password call failed for ${customer.email} (${res.status}): ${body.slice(0, 200)}`)
        continue
      }
      logger.info(`[customer-approved] welcome email triggered for ${customer.email}`)
    } catch (e: any) {
      logger.warn(`[customer-approved] reset-password threw for ${customer.email}: ${e?.message}`)
    }
  }
}

export const config: SubscriberConfig = {
  event: "customer-group.customers_attached",
}

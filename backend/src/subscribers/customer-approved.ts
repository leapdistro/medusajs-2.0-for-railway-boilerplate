import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

const APPROVED_GROUP_NAME = (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

/**
 * Send a "Welcome — set your password" email when a customer becomes
 * approved. Defensive about which event Medusa actually emits — listens
 * to a few variants because the admin UI's path through the workflow
 * graph isn't well documented.
 *
 * Strategy:
 *   - On any of the listened events, resolve the affected customer(s).
 *   - If a customer is now in the "approved" group AND we haven't already
 *     sent their welcome (tracked via customer.metadata.welcomed_at), call
 *     Medusa's reset-password endpoint with context.isWelcome=true. The
 *     password-reset subscriber catches the resulting auth.password_reset
 *     event and sends the welcome email.
 *   - Mark metadata.welcomed_at so toggling the group on/off doesn't spam
 *     duplicate welcome emails.
 *
 * Verbose logging on every fire so we can grep Railway logs to confirm
 * exactly which event variant Medusa emits when admin moves a customer
 * into a group via the admin UI.
 */
export default async function customerApprovedHandler({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventName = (event as any)?.name ?? "<unknown>"
  const data: any = event?.data ?? {}

  logger.info(`[customer-approved] event="${eventName}" data=${JSON.stringify(data).slice(0, 400)}`)

  // Collect candidate customer IDs from whatever shape the event hands us.
  const candidateIds = new Set<string>()
  if (Array.isArray(data?.customer_ids)) data.customer_ids.forEach((id: string) => candidateIds.add(id))
  if (Array.isArray(data?.customers))    data.customers.forEach((c: any) => c?.id && candidateIds.add(c.id))
  if (typeof data?.id === "string")      candidateIds.add(data.id)

  if (candidateIds.size === 0) {
    logger.info(`[customer-approved] no customer ids found in event payload — skipping`)
    return
  }

  const customerService: any = container.resolve(Modules.CUSTOMER)

  // Pull each candidate with their groups so we can check membership.
  let customers: Array<{ id: string; email: string; metadata?: Record<string, any> | null; groups?: Array<{ name?: string }> }> = []
  try {
    customers = await customerService.listCustomers(
      { id: Array.from(candidateIds) },
      { take: candidateIds.size, relations: ["groups"] }
    )
  } catch (e: any) {
    logger.warn(`[customer-approved] could not list customers: ${e?.message}`)
    return
  }

  for (const customer of customers) {
    const inApproved = (customer.groups ?? []).some(
      (g) => String(g?.name ?? "").toLowerCase() === APPROVED_GROUP_NAME
    )
    if (!inApproved) {
      logger.info(`[customer-approved] ${customer.email ?? customer.id} not in "${APPROVED_GROUP_NAME}" — skipping`)
      continue
    }
    const alreadyWelcomed = !!customer.metadata?.welcomed_at
    if (alreadyWelcomed) {
      logger.info(`[customer-approved] ${customer.email ?? customer.id} already welcomed at ${customer.metadata?.welcomed_at} — skipping`)
      continue
    }
    if (!customer.email || !customer.email.includes("@")) {
      logger.warn(`[customer-approved] customer ${customer.id} has no valid email — skipping`)
      continue
    }

    const baseUrl = process.env.MEDUSA_BACKEND_URL || `http://localhost:${process.env.PORT || 9000}`
    const publishableKey = process.env.MEDUSA_PUBLISHABLE_API_KEY

    try {
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

      // Mark so we don't re-send if admin toggles the group.
      try {
        await customerService.updateCustomers(customer.id, {
          metadata: {
            ...(customer.metadata ?? {}),
            welcomed_at: new Date().toISOString(),
            application_status: "approved",
          },
        })
      } catch (e: any) {
        logger.warn(`[customer-approved] could not stamp welcomed_at metadata: ${e?.message}`)
      }
    } catch (e: any) {
      logger.warn(`[customer-approved] reset-password threw for ${customer.email}: ${e?.message}`)
    }
  }
}

export const config: SubscriberConfig = {
  // Listen to multiple variants — Medusa v2 docs are inconsistent and the
  // admin UI's path through the workflow graph isn't documented. Whichever
  // one fires, we handle it.
  event: [
    "customer-group.customers_attached",
    "customer_group.customers_attached",
    "customer.updated",
  ],
}

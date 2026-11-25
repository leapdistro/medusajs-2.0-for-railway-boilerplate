import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findCustomerByEmail, issueAccountLink } from "../lib/account-link"

/**
 * Medusa's own reset-password route (`POST /auth/customer/emailpass/reset-password`)
 * is still reachable. Its token is hard-coded to 15 minutes, so we never
 * email it: when it fires, the customer gets our reset link instead
 * (lib/account-link.ts, 1 hour, single use), the same one /store/mbs/auth/forgot
 * sends. The welcome email and the storefront's forgot-password form no
 * longer go through Medusa's route at all.
 *
 * The event's token is ignored and never logged.
 *
 * Event payload (Medusa v2): { entity_id: <email>, actor_type: "customer", token }
 */
export default async function customerPasswordResetHandler({
  event,
  container,
}: SubscriberArgs<{ entity_id: string; actor_type?: string; token?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const data = event?.data ?? ({} as { entity_id?: string; actor_type?: string })

  // Admin user resets share the event name; not ours to handle.
  if (data.actor_type && data.actor_type !== "customer") return

  const email = String(data.entity_id ?? "")
  if (!email.includes("@")) return

  try {
    const customer = await findCustomerByEmail(container, email)
    if (!customer) {
      logger.info(`[password-reset] Medusa reset for ${email}: no customer record, nothing sent`)
      return
    }
    await issueAccountLink(container, customer, "reset")
  } catch (e: any) {
    logger.warn(`[password-reset] could not send reset link to ${email}: ${e?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: "auth.password_reset",
}

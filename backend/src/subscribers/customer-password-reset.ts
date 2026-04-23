import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Subscribes to Medusa's password-reset events for customers and logs the
 * token + reset link to the server console.
 *
 * Pre-Resend (no email sender wired): admin sees the link in Railway logs
 * and shares with the applicant manually. Once Resend is configured the
 * notification module's own subscriber takes over and emails the link
 * automatically — this subscriber stays as a useful audit log.
 *
 * Event payload shape (Medusa v2):
 *   { entity_id: <auth_identity_id>, actor_type: "customer", token: <jwt> }
 */
export default async function customerPasswordResetHandler({
  event,
  container,
}: SubscriberArgs<{ entity_id: string; actor_type?: string; token?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const data = event?.data ?? ({} as { entity_id?: string; actor_type?: string; token?: string })

  // Only handle customer resets (skip admin user resets if they fire on the same event)
  if (data.actor_type && data.actor_type !== "customer") return

  const token = data.token
  if (!token) {
    logger.warn(`[password-reset] auth.password_reset event fired without a token (auth identity ${data.entity_id})`)
    return
  }

  const storefrontUrl = process.env.STOREFRONT_URL || "http://localhost:3000"
  // Medusa's emailpass provider uses the email as entity_id, so we can pass
  // it through the URL — the storefront uses it for auto sign-in after the
  // password is set. If a future provider changes this, the auto sign-in
  // simply doesn't fire (graceful).
  const email = data.entity_id ?? ""
  const params = new URLSearchParams({ token })
  if (email && email.includes("@")) params.set("email", email)
  const resetUrl = `${storefrontUrl}/auth/reset?${params.toString()}`

  // Log loudly so it's easy to grep in Railway logs while Resend isn't wired
  logger.info(`========== PASSWORD RESET LINK ==========`)
  logger.info(`Email: ${email}`)
  logger.info(`Reset URL: ${resetUrl}`)
  logger.info(`(token expires per Medusa default — usually 15 min)`)
  logger.info(`=========================================`)
}

export const config: SubscriberConfig = {
  event: "auth.password_reset",
}

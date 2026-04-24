import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Subscribes to Medusa's customer password-reset events. Sends the reset
 * link via Resend (when configured) AND logs to the server console as an
 * audit trail / fallback.
 *
 * This handler covers BOTH user contexts:
 *   - User-initiated reset via /auth/forgot
 *   - Approval-welcome flow: customer-approved subscriber triggers a
 *     reset programmatically when admin moves a customer to the
 *     "approved" group, which fires this same event.
 *
 * The `isWelcome` flag is read from event.data.context if present (set
 * by the approval subscriber) so the email copy reframes accordingly.
 *
 * Event payload shape (Medusa v2):
 *   { entity_id: <auth_identity_id ≈ email>, actor_type: "customer", token: <jwt> }
 */
export default async function customerPasswordResetHandler({
  event,
  container,
}: SubscriberArgs<{ entity_id: string; actor_type?: string; token?: string; context?: { isWelcome?: boolean } }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const data = event?.data ?? ({} as { entity_id?: string; actor_type?: string; token?: string; context?: { isWelcome?: boolean } })

  // Skip admin user resets if they fire on the same event channel.
  if (data.actor_type && data.actor_type !== "customer") return

  const token = data.token
  if (!token) {
    logger.warn(`[password-reset] auth.password_reset event fired without a token (auth identity ${data.entity_id})`)
    return
  }

  const storefrontUrl = process.env.STOREFRONT_URL || "http://localhost:3000"
  // Medusa's emailpass provider uses the email as entity_id.
  const email = data.entity_id ?? ""
  const params = new URLSearchParams({ token })
  if (email && email.includes("@")) params.set("email", email)
  const resetUrl = `${storefrontUrl}/auth/reset?${params.toString()}`
  const isWelcome = data.context?.isWelcome === true

  // Audit log — kept even when Resend is wired so devs can grep Railway
  // logs to confirm a reset fired (e.g. when debugging delivery issues).
  logger.info(`========== PASSWORD RESET LINK ==========`)
  logger.info(`Email: ${email}${isWelcome ? " (welcome-on-approval)" : ""}`)
  logger.info(`Reset URL: ${resetUrl}`)
  logger.info(`(token expires per Medusa default — usually 15 min)`)
  logger.info(`=========================================`)

  // Send via Resend if the notification module is configured. Wrapped in
  // try/catch so an email failure never breaks the reset flow itself —
  // worst case the admin can still grab the URL from the log block above.
  if (!email || !email.includes("@")) {
    logger.warn(`[password-reset] entity_id is not an email (${email}); skipping email send`)
    return
  }
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendFrom) {
    logger.info(`[password-reset] RESEND_FROM_EMAIL not set — email delivery disabled (log-only mode).`)
    return
  }
  try {
    const notificationService: any = container.resolve(Modules.NOTIFICATION)
    await notificationService.createNotifications([{
      to: email,
      channel: "email",
      template: "password-reset",
      from: resendFrom,
      data: {
        emailOptions: {
          subject: isWelcome
            ? "Welcome to Mind Body Spirit — set your password"
            : "Reset your Mind Body Spirit password",
        },
        resetUrl,
        isWelcome,
      },
    }])
    logger.info(`[password-reset] sent ${isWelcome ? "welcome" : "reset"} email to ${email} via Resend`)
  } catch (e: any) {
    logger.warn(`[password-reset] email send failed (non-fatal): ${e?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: "auth.password_reset",
}

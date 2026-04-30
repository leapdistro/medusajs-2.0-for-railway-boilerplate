import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Fires a single test email through the notification module — same
 * code path the wholesale-application route uses, just isolated.
 *
 * Use this to confirm the Resend provider is registered and the env
 * vars are actually being picked up. If this works locally but the
 * same email fails on Railway, you know it's a production-only
 * deploy/build issue (try a redeploy).
 *
 * Usage:
 *   TO_EMAIL=you@example.com pnpm test:email
 */
export default async function testEmail({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const to = process.env.TO_EMAIL
  if (!to) {
    logger.error("✗ TO_EMAIL env var is required (where to send the test)")
    return
  }

  /* Verify env vars are being read. */
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  logger.info(`▶ RESEND_API_KEY:    ${apiKey ? `${apiKey.slice(0, 10)}…` : "(MISSING)"}`)
  logger.info(`▶ RESEND_FROM_EMAIL: ${from ?? "(MISSING)"}`)
  if (!apiKey || !from) {
    logger.error("✗ Resend env vars not set. Add them to .env and restart.")
    return
  }

  let notificationService: any
  try {
    notificationService = container.resolve(Modules.NOTIFICATION)
  } catch (e: any) {
    logger.error(`✗ Notification module not registered: ${e?.message}`)
    logger.error("  → Check that medusa-config.js's notification block is loading.")
    return
  }
  logger.info("✓ Notification module resolved")

  /* The wholesale-application route uses these template keys. We use
   * the simplest one (`wholesale-application-applicant`) as the test. */
  logger.info(`▶ Sending test email to ${to}…`)
  try {
    await notificationService.createNotifications([{
      to,
      channel: "email",
      template: "wholesale-application-applicant",
      from,
      data: {
        emailOptions: {
          subject: "MBS — test email (please ignore)",
        },
        contactName: "Test User",
        businessName: "Test Business",
      },
    }])
    logger.info(`✓ Notification queued. Check ${to} (and Resend dashboard) within ~10s.`)
  } catch (e: any) {
    logger.error(`✗ Send failed: ${e?.message}`)
    if (e?.message?.includes("provider for channel")) {
      logger.error("  → Same error as production. Provider isn't registering.")
      logger.error("  → Inspect medusa-config.js notification block.")
    }
  }
}

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { sendOrderPlacedEmails } from "../modules/email-notifications/lib/order-email-data"

/**
 * Manually fire the 3 order-placed emails for a given order, bypassing
 * the event bus entirely. Tells us whether the email assembly + send
 * pipeline works independently of the order.placed subscriber wiring.
 *
 * Usage (env var is most reliable — pnpm/medusa-exec arg forwarding
 * has shell-specific quirks):
 *   ORDER_ID=order_01... pnpm test:resend
 * Or (if arg forwarding works in your shell):
 *   pnpm test:resend -- order_01...
 */
export default async function testResend({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = process.env.ORDER_ID || args?.[0]

  if (!orderId) {
    logger.error("Missing order id. Use:  ORDER_ID=order_01... pnpm test:resend")
    return
  }

  logger.info(`▶ Resending order-placed emails for ${orderId}…`)
  const result = await sendOrderPlacedEmails(container, orderId)

  logger.info("──────────────── Result ────────────────")
  logger.info(`ok                       = ${result.ok}`)
  logger.info(`displayId                = ${result.displayId ?? "(none)"}`)
  logger.info(`receivedSent             = ${result.receivedSent ?? false}`)
  logger.info(`teamAlertSent            = ${result.teamAlertSent ?? false}`)
  logger.info(`paymentInstructionsSent  = ${result.paymentInstructionsSent ?? false}`)
  logger.info(`paymentInstructionsSkipped = ${result.paymentInstructionsSkipped ?? false}`)
  if (result.errors.length) {
    logger.info("errors:")
    for (const e of result.errors) logger.info(`  - ${e}`)
  } else {
    logger.info("errors: (none)")
  }
  logger.info("───────────────────────────────────────")

  if (result.ok) {
    logger.info("✓ All sends accepted by Resend. Check the inboxes (buyer + wholesale@hempmbs.com).")
  } else {
    logger.warn("✗ One or more sends failed — see errors above.")
  }
}

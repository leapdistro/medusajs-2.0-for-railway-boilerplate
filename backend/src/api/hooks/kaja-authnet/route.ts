import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * POST /hooks/kaja-authnet
 *
 * Authorize.net Webhook Notifications endpoint. KAJA / Authorize.net
 * pings this URL when:
 *   - net.authorize.payment.authcapture.created  (charge confirmed)
 *   - net.authorize.payment.refund.created       (refund posted)
 *   - net.authorize.payment.void.created         (void posted)
 *   - net.authorize.payment.fraud.{held,approved,declined}
 *   - net.authorize.payment.{authorization,capture,priorAuthCapture}.created
 *     (dormant until auth_only mode lands)
 *
 * Stub right now — returns 200 to anything so the dashboard's "verify
 * URL is reachable" check passes during webhook setup. Once the
 * Signature Key is in env, this gets HMAC-SHA512 verification +
 * dispatch to provider.getWebhookActionAndData → Medusa's
 * processPaymentWebhookEventWorkflow which applies the state change.
 *
 * Always returns 200 with an empty body. Authorize.net retries on
 * non-2xx, so blanket-200 + log-the-payload is the safe stub: we
 * never block, we never lose data, and once we ship the real handler
 * any "missed" events would be re-deliverable from their dashboard.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const body = req.body as Record<string, any> | undefined
  const eventType = body?.eventType ?? "(unknown event)"
  const notificationId = body?.notificationId ?? "(unknown id)"
  const sigHeader = req.headers?.["x-anet-signature"] ?? "(no signature)"

  logger.info(
    `[kaja-authnet webhook] received ${eventType} (notification ${notificationId}). ` +
    `sig=${String(sigHeader).slice(0, 24)}… body-keys=${Object.keys(body ?? {}).join(",")}`,
  )

  res.status(200).json({ ok: true })
}

/* Authorize.net's verification ping is a GET in some setups. Mirror
 * the POST behavior so dashboard validation passes either way. */
export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
  res.status(200).json({ ok: true, message: "kaja-authnet webhook endpoint" })
}

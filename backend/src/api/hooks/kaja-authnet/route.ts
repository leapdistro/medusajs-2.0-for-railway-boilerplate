import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import crypto from "crypto"

/**
 * POST /hooks/kaja-authnet
 *
 * Authorize.net Webhook Notifications endpoint. KAJA / Authorize.net
 * pings this URL on every transaction state change. Currently subscribed:
 *
 *   net.authorize.payment.authcapture.created       (sale captured)
 *   net.authorize.payment.authorization.created     (auth-only — dormant)
 *   net.authorize.payment.capture.created           (capture — dormant)
 *   net.authorize.payment.priorAuthCapture.created  (capture-on-fulfillment — dormant)
 *   net.authorize.payment.refund.created            (refund posted)
 *   net.authorize.payment.void.created              (void posted)
 *   net.authorize.payment.fraud.held                (FDS held → manual review)
 *   net.authorize.payment.fraud.approved            (FDS released by operator)
 *   net.authorize.payment.fraud.declined            (FDS rejected by operator)
 *
 * Design note: refund/void/capture state is already updated synchronously
 * via the provider's admin-initiated lifecycle methods. Webhooks for those
 * events are confirmation + audit. The high-value signal is FRAUD — those
 * fire asynchronously from Authorize.net's FDS and need operator attention.
 *
 * This handler:
 *   1. Verifies HMAC-SHA512 against KAJA_WEBHOOK_SIGNATURE_KEY.
 *   2. Dedupes by notificationId via the cache module (Authorize.net retries
 *      on non-2xx; in-memory cache window is plenty).
 *   3. Structured-logs every event for Railway log search.
 *   4. Logs fraud events at WARN level so they jump out of normal traffic.
 *   5. Returns 200 (or 401 on bad signature). Always 200 after verify —
 *      we don't want Authorize.net retrying on transient handler errors
 *      since we've already captured the event in logs.
 */

type KajaWebhookPayload = {
  notificationId?: string
  eventType?: string
  eventDate?: string
  webhookId?: string
  payload?: {
    id?: string                  // transId for payment events
    entityName?: string
    authAmount?: number
    requestedAmount?: number
    settleAmount?: number
    invoiceNumber?: string
    merchantReferenceId?: string
    responseCode?: number
    authCode?: string
    avsResponse?: string
  }
}

/**
 * Constant-time HMAC-SHA512 verification.
 *
 * Authorize.net's signature header looks like `sha512=ABCDEF1234...`
 * (uppercase hex). We compute HMAC-SHA512 of the *raw* request body
 * using the merchant's Signature Key (the key string as-is, not a
 * decoded hex value).
 */
function verifySignature(rawBody: Buffer, signatureHeader: string, key: string): boolean {
  if (!signatureHeader || !key || !rawBody?.length) return false
  const match = signatureHeader.match(/^sha512=(.+)$/i)
  const expected = (match ? match[1] : signatureHeader).trim()
  /* Hex sanity check before we try to decode — bogus headers shouldn't
   * throw out of Buffer.from. */
  if (!/^[0-9a-fA-F]+$/.test(expected)) return false

  const computed = crypto.createHmac("sha512", key).update(rawBody).digest("hex")
  const a = Buffer.from(computed.toLowerCase(), "hex")
  const b = Buffer.from(expected.toLowerCase(), "hex")
  if (a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(a, b)
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  /* ─── 1. Signature verification ────────────────────────────────── */
  const sigHeader = String(req.headers["x-anet-signature"] ?? "")
  const key = process.env.KAJA_WEBHOOK_SIGNATURE_KEY
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody

  if (!key) {
    /* Hard-fail when the key isn't configured. Returning 200 here would
     * mean we silently accept unverified events in prod — better to
     * surface the misconfiguration loudly and let Authorize.net retry. */
    logger.error("[kaja-authnet webhook] KAJA_WEBHOOK_SIGNATURE_KEY not set — rejecting all events until configured")
    res.status(503).json({ ok: false, error: "Webhook signature key not configured" })
    return
  }

  if (!rawBody || !verifySignature(rawBody, sigHeader, key)) {
    logger.warn(
      `[kaja-authnet webhook] signature verification failed. ` +
      `sig=${sigHeader.slice(0, 30)}… bodyLen=${rawBody?.length ?? 0}`,
    )
    res.status(401).json({ ok: false, error: "Invalid signature" })
    return
  }

  /* ─── 2. Parse + dedupe ────────────────────────────────────────── */
  const body = (req.body ?? {}) as KajaWebhookPayload
  const eventType = body.eventType ?? "(unknown)"
  const notificationId = body.notificationId ?? ""
  const transId = body.payload?.id ?? ""

  if (notificationId) {
    /* Cache module is in-memory by default (see medusa-config.js — no
     * cache-redis registered). That's fine: Authorize.net retries happen
     * within minutes/hours of a non-2xx, and we always return 200 once
     * we get past signature verification. The 7-day TTL is generous
     * insurance against a single backend restart between retries. */
    const cache = req.scope.resolve(Modules.CACHE) as {
      get: (k: string) => Promise<unknown>
      set: (k: string, v: unknown, ttlSec?: number) => Promise<void>
    }
    const cacheKey = `kaja:webhook:notif:${notificationId}`
    const seen = await cache.get(cacheKey)
    if (seen) {
      logger.info(`[kaja-authnet webhook] duplicate notification ${notificationId} (${eventType}) — already processed`)
      res.status(200).json({ ok: true, deduped: true })
      return
    }
    await cache.set(cacheKey, "1", 60 * 60 * 24 * 7)
  }

  /* ─── 3. Dispatch ──────────────────────────────────────────────── */
  const amount = body.payload?.authAmount ?? body.payload?.settleAmount ?? body.payload?.requestedAmount
  const baseLog =
    `event=${eventType} transId=${transId} amount=${amount ?? "n/a"} ` +
    `notif=${notificationId} eventDate=${body.eventDate ?? "n/a"}`

  if (eventType.startsWith("net.authorize.payment.fraud.")) {
    /* Fraud events are the asynchronous signal we can't get any other
     * way — log at WARN so they stand out in Railway. The full payload
     * is included so an operator can map back to the order without
     * touching the database. */
    const outcome = eventType.split(".").pop() ?? "unknown"
    logger.warn(`[kaja-authnet webhook] FRAUD.${outcome.toUpperCase()} ${baseLog} payload=${JSON.stringify(body.payload ?? {})}`)
  } else if (
    eventType === "net.authorize.payment.authcapture.created" ||
    eventType === "net.authorize.payment.refund.created" ||
    eventType === "net.authorize.payment.void.created"
  ) {
    /* Confirmation events for synchronous admin/checkout actions.
     * State is already updated in Medusa; we log for the audit trail
     * and to detect drift (e.g. a refund issued directly from the
     * Authorize.net dashboard would show up here without a matching
     * Medusa-side refund). */
    logger.info(`[kaja-authnet webhook] ${baseLog}`)
  } else if (
    eventType === "net.authorize.payment.authorization.created" ||
    eventType === "net.authorize.payment.capture.created" ||
    eventType === "net.authorize.payment.priorAuthCapture.created"
  ) {
    /* auth_only / capture-on-fulfillment mode events. The provider runs
     * in authCaptureTransaction (one-step) mode today, so these are
     * dormant — they'll start firing if/when the auth_only toggle ships.
     * Log at INFO until that's wired up. */
    logger.info(`[kaja-authnet webhook] (auth_only-mode event, dormant) ${baseLog}`)
  } else {
    logger.info(`[kaja-authnet webhook] (unhandled event type) ${baseLog}`)
  }

  res.status(200).json({ ok: true })
}

/* Authorize.net's dashboard verification ping may be a GET in some
 * setups. Mirror the success path so dashboard "test endpoint" buttons
 * report reachable. */
export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
  res.status(200).json({ ok: true, message: "kaja-authnet webhook endpoint" })
}

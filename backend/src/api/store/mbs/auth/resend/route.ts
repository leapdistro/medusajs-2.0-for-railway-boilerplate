import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { checkAccountLink, issueAccountLink } from "../../../../../lib/account-link"
import { takeUsage } from "../../../../../lib/usage-cap"

/**
 * POST /store/mbs/auth/resend
 * Body: { token }
 *
 * "Email me a new link" on an expired link. Only the customer's current
 * link, once expired, can ask; the new link (same kind: welcome or reset,
 * full lifetime) goes to the email on the account, never to the caller.
 * A used or replaced link gets { sent: false } and the page points to
 * sign-in or forgot password instead.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { state, purpose, customer } = await checkAccountLink(req.scope, body.token)
  if (state !== "expired" || !customer || !purpose) {
    return res.json({ ok: true, sent: false, state })
  }

  const ip = (req.get("x-mbs-client-ip") || req.ip || "anon").slice(0, 64)
  const allowed = await takeUsage([
    { key: `link-resend:cus:${customer.id}`, limit: 3, seconds: 60 * 60 },
    { key: `link-resend:ip:${ip}`, limit: 10, seconds: 15 * 60 },
  ])
  if (!allowed) {
    return res.status(429).json({ ok: false, sent: false, message: "A new link was sent recently. Check your inbox, or try again in an hour." })
  }

  const result = await issueAccountLink(req.scope, customer, purpose)
  if (!result.emailSent) {
    return res.status(502).json({ ok: false, sent: false, message: "We couldn't send the email. Please contact us and we'll get you set up." })
  }
  return res.json({ ok: true, sent: true })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findCustomerByEmail, hasPasswordIdentity, issueAccountLink } from "../../../../../lib/account-link"
import { takeUsage } from "../../../../../lib/usage-cap"

/**
 * POST /store/mbs/auth/forgot
 * Body: { email }
 *
 * Emails a 1-hour reset link (replacing any older link) when the email
 * belongs to a customer who can sign in with a password. Always answers
 * { ok: true } so the response never says whether an account exists.
 * The storefront route in front of it adds Turnstile, a honeypot and its
 * own rate limits; these caps cover direct calls.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const body = (req.body ?? {}) as Record<string, unknown>
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : ""
  if (!email.includes("@")) return res.json({ ok: true })

  const ip = (req.get("x-mbs-client-ip") || req.ip || "anon").slice(0, 64)
  const allowed = await takeUsage([
    { key: `forgot:email:${email}`, limit: 5, seconds: 60 * 60 },
    { key: `forgot:ip:${ip}`, limit: 20, seconds: 15 * 60 },
  ])
  if (!allowed) {
    logger.warn(`[forgot] rate-limited (${email})`)
    return res.json({ ok: true })
  }

  // Not awaited: answering at the same speed whether or not the account
  // exists keeps response timing from giving it away.
  void (async () => {
    const customer = await findCustomerByEmail(req.scope, email)
    if (customer && (await hasPasswordIdentity(req.scope, customer.email))) {
      await issueAccountLink(req.scope, customer, "reset")
    }
  })().catch((e: any) => logger.warn(`[forgot] failed for ${email}: ${e?.message}`))
  return res.json({ ok: true })
}

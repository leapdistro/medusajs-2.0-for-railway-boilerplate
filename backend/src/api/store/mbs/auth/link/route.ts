import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { checkAccountLink } from "../../../../../lib/account-link"

/**
 * POST /store/mbs/auth/link  Body: { token }
 *
 * What a set-password link is now (valid / expired / used / invalid) and
 * which kind it is. Read-only: opening the page, or an email scanner
 * fetching it, never spends the link. Only the token holder learns
 * anything, and nothing about the account beyond the state.
 *
 * The token goes in the body, never the URL: Railway logs every request
 * path, so a `?token=` query would put live links in the logs.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const token = typeof body.token === "string" ? body.token : ""
  const { state, purpose } = await checkAccountLink(req.scope, token)
  res.set("Cache-Control", "no-store")
  return res.json({ state, purpose: purpose ?? null })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { checkAccountLink } from "../../../../../lib/account-link"

/**
 * GET /store/mbs/auth/link?token=
 *
 * What a set-password link is now (valid / expired / used / invalid) and
 * which kind it is. Read-only: opening the page, or an email scanner
 * fetching it, never spends the link. Only the token holder learns
 * anything, and nothing about the account beyond the state.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const token = String((req.query as any)?.token ?? "")
  const { state, purpose } = await checkAccountLink(req.scope, token)
  res.set("Cache-Control", "no-store")
  return res.json({ state, purpose: purpose ?? null })
}

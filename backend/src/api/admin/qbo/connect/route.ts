import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { randomBytes } from "crypto"
import { buildAuthorizeUrl } from "../../../../lib/qbo-oauth"

/**
 * GET /admin/qbo/connect
 * Generates a random state token and redirects the operator to Intuit's
 * OAuth consent screen. Intuit will redirect back to /admin/qbo/oauth/callback
 * after the operator authorizes (or denies) the connection.
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  /* State is for CSRF protection. We don't currently validate it on the
   * callback (single-operator admin, low risk), but Intuit requires the
   * parameter so we generate a real one. */
  const state = randomBytes(16).toString("hex")
  try {
    const url = await buildAuthorizeUrl(state)
    res.redirect(url)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "QBO not configured" })
  }
}

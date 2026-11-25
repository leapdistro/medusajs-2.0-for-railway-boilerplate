import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { consumeAccountLink } from "../../../../../lib/account-link"
import { takeUsage } from "../../../../../lib/usage-cap"

/**
 * POST /store/mbs/auth/set-password
 * Body: { token, password }
 *
 * Sets the password with a welcome or forgot-password link and spends the
 * link. On success returns the account email so the storefront can sign
 * the buyer straight in. On failure returns the link's state so the page
 * can show the right next step (expired → email a new link, used → sign in).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const token = typeof body.token === "string" ? body.token : ""
  const password = typeof body.password === "string" ? body.password : ""

  if (!token) return res.status(400).json({ ok: false, state: "invalid", message: "Missing link token." })
  if (password.length < 8) {
    return res.status(400).json({ ok: false, state: "valid", message: "Password must be at least 8 characters." })
  }
  if (password.length > 128) {
    return res.status(400).json({ ok: false, state: "valid", message: "Password must be 128 characters or fewer." })
  }

  const ip = (req.get("x-mbs-client-ip") || req.ip || "anon").slice(0, 64)
  if (!(await takeUsage([{ key: `set-password:ip:${ip}`, limit: 20, seconds: 15 * 60 }]))) {
    return res.status(429).json({ ok: false, state: "valid", message: "Too many tries. Wait a few minutes and try again." })
  }

  const result = await consumeAccountLink(req.scope, token, password)
  // `"state" in` narrows the union (this tsconfig doesn't narrow on `!result.ok`).
  if ("state" in result) {
    const status = result.state === "failed" ? 500 : 410
    return res.status(status).json(result)
  }
  return res.json(result)
}

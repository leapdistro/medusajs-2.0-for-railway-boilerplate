import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { applyOwnerPrices } from "../../../../../../lib/owner-prices-apply"

/**
 * POST /admin/mbs/settings/owner-prices/apply { scope: "flower" | "preroll" }
 *
 * Thin wrapper around lib/owner-prices-apply — same logic is invoked
 * by the receiving subscriber (subscribers/receiving-to-owner-prices.ts)
 * so a successful receiving auto-refreshes owner prices for the
 * touched profile.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { scope?: "flower" | "preroll" }
  const scope = body.scope ?? "flower"
  if (scope !== "flower" && scope !== "preroll") {
    res.status(400).json({ ok: false, message: `Invalid scope "${scope}" — must be "flower" or "preroll"` })
    return
  }

  const result = await applyOwnerPrices(req.scope, scope)
  if (!result.ok) {
    res.status(400).json({ ok: false, message: result.error ?? "Apply failed", summary: result })
    return
  }
  res.json({ ok: true, summary: result })
}

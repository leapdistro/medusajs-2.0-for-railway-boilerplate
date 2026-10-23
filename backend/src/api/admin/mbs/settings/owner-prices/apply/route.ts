import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { applyOwnerPrices } from "../../../../../../lib/owner-prices-apply"
import { resolveRequestTable } from "../../../../../../lib/price-levels"
import { loadProfiles } from "../../../../../../lib/profile-store"

/**
 * POST /admin/mbs/settings/owner-prices/apply { table, dryRun? }
 *
 * `table` is the markup setting a category profile names as
 * priceTables.owner. Legacy { scope: "flower" | "preroll" } still
 * resolves through the profiles.
 *
 * Thin wrapper around lib/owner-prices-apply — same logic is invoked
 * by the receiving subscriber (subscribers/receiving-to-owner-prices.ts)
 * so a successful receiving auto-refreshes owner prices for the
 * touched profile.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { table?: unknown; scope?: unknown; dryRun?: unknown }
  const { profiles } = await loadProfiles(req.scope)
  const resolved = resolveRequestTable(profiles, "owner", body)
  if ("error" in resolved) {
    res.status(400).json({ ok: false, message: resolved.error })
    return
  }

  const result = await applyOwnerPrices(req.scope, resolved.table, { dryRun: body.dryRun === true })
  if (!result.ok) {
    res.status(400).json({ ok: false, message: result.error ?? "Apply failed", summary: result })
    return
  }
  const { planned, ...summary } = result
  res.json({ ok: true, summary, ...(planned ? { planned } : {}) })
}

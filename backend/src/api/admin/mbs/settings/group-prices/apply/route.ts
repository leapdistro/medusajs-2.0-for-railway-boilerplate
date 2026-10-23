import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { applyGroupPrices, type GroupKey } from "../../../../../../lib/group-prices-apply"
import { GROUP_LEVELS, resolveRequestTable } from "../../../../../../lib/price-levels"
import { loadProfiles } from "../../../../../../lib/profile-store"

/**
 * POST /admin/mbs/settings/group-prices/apply
 *   { table, group: "distro" | "tier_2" | "tier_3", dryRun? }
 *
 * `table` is the mbs-settings key a category profile names at that
 * level (priceTables in MBS Settings → Categories). Legacy
 * { scope: "flower" | "preroll" } still resolves through the profiles.
 *
 * Thin HTTP wrapper around `applyGroupPrices` (lib/group-prices-apply.ts).
 * The shared lib was extracted so the receiving.saved subscriber can
 * call the same code path — see subscribers/receiving-to-group-prices.
 *
 * All the interesting behavior (variant resolution ladder, find-or-
 * create PriceList, add-vs-update, sample write verification) lives in
 * the lib. This handler only parses body, validates enum values, and
 * shapes the response.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { table?: unknown; scope?: unknown; group?: GroupKey; dryRun?: unknown }
  const group = body.group ?? "distro"
  if (!GROUP_LEVELS.includes(group)) {
    res.status(400).json({
      ok: false,
      message: `Invalid group "${group}" — must be one of ${GROUP_LEVELS.join(", ")}`,
    })
    return
  }

  const { profiles } = await loadProfiles(req.scope)
  const resolved = resolveRequestTable(profiles, group, body)
  if ("error" in resolved) {
    res.status(400).json({ ok: false, message: resolved.error })
    return
  }

  const result = await applyGroupPrices(req.scope, resolved.table, group, { dryRun: body.dryRun === true })

  if (!result.ok) {
    /* Configuration errors (settings missing, customer group missing)
     * are 400 — operator can fix. Write-verification failures come with
     * a summary already; treat those as 500 since they indicate a
     * pricing-service issue. */
    const status = result.summary ? 500 : 400
    res.status(status).json({
      ok: false,
      message: result.error ?? "Apply failed",
      summary: result.summary,
    })
    return
  }

  res.json({ ok: true, summary: result.summary, ...(result.planned ? { planned: result.planned } : {}) })
}

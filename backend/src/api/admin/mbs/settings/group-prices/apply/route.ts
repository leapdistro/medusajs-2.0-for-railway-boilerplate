import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  applyGroupPrices,
  type GroupKey,
  type GroupScope,
} from "../../../../../../lib/group-prices-apply"

/**
 * POST /admin/mbs/settings/group-prices/apply
 *   { scope: "flower" | "preroll" | "thcp_flower", group: "distro" | "tier_2" | "tier_3" }
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

const VALID_SCOPES: GroupScope[] = ["flower", "preroll", "thcp_flower"]
const VALID_GROUPS: GroupKey[] = ["distro", "tier_2", "tier_3"]

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { scope?: GroupScope; group?: GroupKey }
  const scope = body.scope ?? "flower"
  const group = body.group ?? "distro"

  if (!VALID_SCOPES.includes(scope)) {
    res.status(400).json({
      ok: false,
      message: `Invalid scope "${scope}" — must be one of ${VALID_SCOPES.join(", ")}`,
    })
    return
  }
  if (!VALID_GROUPS.includes(group)) {
    res.status(400).json({
      ok: false,
      message: `Invalid group "${group}" — must be one of ${VALID_GROUPS.join(", ")}`,
    })
    return
  }

  const result = await applyGroupPrices(req.scope, scope, group)

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

  res.json({ ok: true, summary: result.summary })
}

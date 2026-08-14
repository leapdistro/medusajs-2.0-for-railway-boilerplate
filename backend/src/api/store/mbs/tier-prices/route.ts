import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * GET /store/mbs/tier-prices
 *
 * Returns the homepage-display tier-price maps for the signed-in buyer,
 * resolved to whichever pricing mode they belong to. Shape unchanged
 * — flower_tier_prices: { classic: { qp, half, lb }, ... }; pre_roll_tier_prices:
 * { thc-a: { 30pk }, ... }. Only the SOURCE of the numbers varies.
 *
 * Pricing-mode → settings-key map:
 *   null / default → flower_tier_prices       + pre_roll_tier_prices
 *   tier_2         → flower_tier_2_prices     + preroll_tier_2_prices
 *   tier_3         → flower_tier_3_prices     + preroll_tier_3_prices
 *   distro         → flower_distro_prices     + preroll_distro_prices
 *   owner_stores   → flower_tier_prices       + pre_roll_tier_prices
 *                    (i.e. same as default — owner_stores buyers see
 *                     default prices on the home page even though their
 *                     ACTUAL price at PDP / cart / checkout is
 *                     (landed + markup) × pool_units. Intentional
 *                     simplification: owner_stores prices are
 *                     variant-specific not tier-fixed, so there's no
 *                     clean "From $X" headline to show on the home
 *                     page. PDP price resolution via calculated_price
 *                     is unchanged and remains authoritative.)
 *
 * Gated to approved wholesale customers ONLY. Non-approved or anonymous
 * callers get 401/403 — the prices never leave the backend for them.
 * Storefront home-page CategoryShowcase fetches this server-side via
 * a NextAuth-gated proxy.
 */
const FLOWER_KEY_BY_MODE: Record<string, string> = {
  tier_2:       "flower_tier_2_prices",
  tier_3:       "flower_tier_3_prices",
  distro:       "flower_distro_prices",
  owner_stores: "flower_tier_prices",
}
const PREROLL_KEY_BY_MODE: Record<string, string> = {
  tier_2:       "preroll_tier_2_prices",
  tier_3:       "preroll_tier_3_prices",
  distro:       "preroll_distro_prices",
  owner_stores: "pre_roll_tier_prices",
}
/* THC-P Flower has fewer pricing modes today (default + distro only).
 * tier_2 / tier_3 fall back to default until an operator adds the
 * corresponding setting keys — no null gap on the home page.
 * owner_stores mirrors flower's simplification: shows default price. */
const THCP_FLOWER_KEY_BY_MODE: Record<string, string> = {
  distro:       "thcp_flower_distro_prices",
  tier_2:       "thcp_flower_prices",
  tier_3:       "thcp_flower_prices",
  owner_stores: "thcp_flower_prices",
}
const FLOWER_DEFAULT_KEY      = "flower_tier_prices"
const PREROLL_DEFAULT_KEY     = "pre_roll_tier_prices"
const THCP_FLOWER_DEFAULT_KEY = "thcp_flower_prices"
/* CBD + CBG default price tables — visible to every approved buyer.
 * No per-mode variants today (segmentation-first: the cbd_cbg customer
 * group exists but doesn't override pricing until operator adds
 * group-scoped tables). If we ever add cbd_cbg-mode overrides, wire a
 * FLOWER_CBD_KEY_BY_MODE + FLOWER_CBG_KEY_BY_MODE map here. */
const FLOWER_CBD_DEFAULT_KEY  = "flower_cbd_prices"
const FLOWER_CBG_DEFAULT_KEY  = "flower_cbg_prices"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService
    .listCustomers({ id: [customerId] }, { take: 1, relations: ["groups"] })
    .catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  const isApproved = ((customer.groups ?? []) as Array<{ name?: string | null }>)
    .some((g) => g?.name === "approved")
  if (!isApproved) {
    return res.status(403).json({ ok: false, message: "Approval required" })
  }

  /* Resolve pricing mode. Prefer the metadata mirror (set by the
   * admin pricing-mode widget) over walking customer.groups — the
   * metadata is the canonical source the rest of the storefront
   * already reads from. Falls back to default for any unrecognised
   * value so a typo doesn't blank out the home page. */
  const rawMode = (customer.metadata as Record<string, any> | undefined)?.pricing_mode
  const mode = typeof rawMode === "string" ? rawMode : null
  const flowerKey     = FLOWER_KEY_BY_MODE[mode ?? ""]      ?? FLOWER_DEFAULT_KEY
  const prerollKey    = PREROLL_KEY_BY_MODE[mode ?? ""]     ?? PREROLL_DEFAULT_KEY
  const thcpFlowerKey = THCP_FLOWER_KEY_BY_MODE[mode ?? ""] ?? THCP_FLOWER_DEFAULT_KEY

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const [flowerPrices, preRollPrices, thcpFlowerPrices, cbdFlowerPrices, cbgFlowerPrices] = await Promise.all([
    settings.getSetting(flowerKey).catch(() => null),
    settings.getSetting(prerollKey).catch(() => null),
    settings.getSetting(thcpFlowerKey).catch(() => null),
    settings.getSetting(FLOWER_CBD_DEFAULT_KEY).catch(() => null),
    settings.getSetting(FLOWER_CBG_DEFAULT_KEY).catch(() => null),
  ])

  return res.json({
    ok: true,
    /* Legacy field name — flower-only callers still read this. */
    tier_prices: flowerPrices ?? null,
    /* Split shape for clarity at call sites. Every ladder is surfaced
     * as its own top-level field. Flower branches (THC-A, CBD, CBG) key
     * by (tier × size); THC-P + pre-roll key by (subcategory × size). */
    flower_tier_prices: flowerPrices ?? null,
    pre_roll_tier_prices: preRollPrices ?? null,
    thcp_flower_prices: thcpFlowerPrices ?? null,
    flower_cbd_prices: cbdFlowerPrices ?? null,
    flower_cbg_prices: cbgFlowerPrices ?? null,
    /* Echo back the resolved mode + source keys for debugging. */
    pricing_mode: mode ?? "default",
    sources: {
      flower: flowerKey,
      preroll: prerollKey,
      thcp_flower: thcpFlowerKey,
      flower_cbd: FLOWER_CBD_DEFAULT_KEY,
      flower_cbg: FLOWER_CBG_DEFAULT_KEY,
    },
  })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"
import { findProfileRoot, loadProfiles } from "../../../../lib/profile-store"
import { loadCategoryTree } from "../../../../lib/category-tree"
import { displayTableFor, tableFor } from "../../../../lib/price-levels"

/**
 * GET /store/mbs/tier-prices
 *
 * Returns the homepage-display tier-price maps for the signed-in buyer,
 * resolved to whichever pricing mode they belong to. Shape unchanged
 * — flower_tier_prices: { classic: { qp, half, lb }, ... }; pre_roll_tier_prices:
 * { thc-a: { 30pk }, ... }. Only the SOURCE of the numbers varies.
 *
 * Each category profile names its table per level (MBS Settings →
 * Categories, lib/price-levels.ts displayTableFor). For the built-in
 * profiles that is:
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
 * `categories` lists every active category with its display table for
 * the buyer's mode and its top-level category as it is named in Medusa
 * now; the named fields below are kept for the current storefront.
 *
 * Gated to approved wholesale customers ONLY. Non-approved or anonymous
 * callers get 401/403 — the prices never leave the backend for them.
 * Storefront home-page CategoryShowcase fetches this server-side via
 * a NextAuth-gated proxy.
 */
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
  const { profiles } = await loadProfiles(req.scope)
  const byKey = (key: string) => profiles.find((p) => p.key === key)
  const display = (key: string) => {
    const p = byKey(key)
    return p ? displayTableFor(p, mode) : null
  }
  const flowerKey = display("flower")
  const prerollKey = display("pre-roll")
  const cbdKey = display("flower-cbd")
  /* CBG keeps its single default table on the home page. */
  const cbgFlower = byKey("flower-cbg")
  const cbgKey = cbgFlower ? tableFor(cbgFlower, "default") : null

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const cache = new Map<string, Promise<any>>()
  const read = (key: string | null) => {
    if (!key) return Promise.resolve(null)
    if (!cache.has(key)) cache.set(key, settings.getSetting(key).catch(() => null))
    return cache.get(key)!
  }

  const active = profiles.filter((p) => !p.archived)
  const [flowerPrices, preRollPrices, cbdFlowerPrices, cbgFlowerPrices, categoryPrices, tree] = await Promise.all([
    read(flowerKey),
    read(prerollKey),
    read(cbdKey),
    read(cbgKey),
    Promise.all(active.map((p) => read(displayTableFor(p, mode)))),
    loadCategoryTree(req.scope.resolve(ContainerRegistrationKeys.QUERY)),
  ])
  const topOf = (p: (typeof active)[number]) => findProfileRoot([...tree.byId.values()], p).parent

  return res.json({
    ok: true,
    /* Legacy field name — flower-only callers still read this. */
    tier_prices: flowerPrices ?? null,
    /* Split shape for clarity at call sites. Every ladder is surfaced
     * as its own top-level field. Flower branches (THC-A, CBD, CBG) key
     * by (tier × size); THC-P + pre-roll key by (subcategory × size). */
    flower_tier_prices: flowerPrices ?? null,
    pre_roll_tier_prices: preRollPrices ?? null,
    flower_cbd_prices: cbdFlowerPrices ?? null,
    flower_cbg_prices: cbgFlowerPrices ?? null,
    categories: active.map((p, i) => ({
      key: p.key,
      name: p.displayName,
      parent_category: topOf(p)?.name ?? p.parentCategoryName,
      parent_category_handle: topOf(p)?.handle ?? null,
      table: displayTableFor(p, mode),
      prices: categoryPrices[i] ?? null,
    })),
    /* Echo back the resolved mode + source keys for debugging. */
    pricing_mode: mode ?? "default",
    sources: {
      flower: flowerKey,
      preroll: prerollKey,
      flower_cbd: cbdKey,
      flower_cbg: cbgKey,
    },
  })
}

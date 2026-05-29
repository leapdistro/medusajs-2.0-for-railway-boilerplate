import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * GET /store/mbs/tier-prices
 *
 * Returns the operator-managed flower_tier_prices map from mbs-settings
 * (shape: { classic: { qp, half, lb }, exotic: {...}, super: {...}, ... }).
 *
 * Gated to approved wholesale customers ONLY. Non-approved or anonymous
 * callers get 401/403 — the prices never leave the backend for them.
 * Storefront's home-page CategoryShowcase fetches this server-side via
 * a NextAuth-gated proxy at /api/home/tier-prices.
 *
 * Why an auth-gated route at all (not just "everyone sees it"): MBS
 * wholesale pricing is private — public visibility would let competitors
 * scrape the tier ladder. The home-page tier cards render a placeholder
 * for non-approved viewers; only approved buyers see real numbers.
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

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const tierPrices = await settings.getSetting("flower_tier_prices").catch(() => null)

  return res.json({ ok: true, tier_prices: tierPrices ?? null })
}

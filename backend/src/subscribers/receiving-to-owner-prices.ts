import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { applyOwnerPrices } from "../lib/owner-prices-apply"
import { findProfile } from "../lib/profile-store"
import { tableFor } from "../lib/price-levels"

/**
 * Auto-refresh Owner Stores PriceList after a successful receiving.
 *
 * Owner Stores prices = (landed_cost + markup) × pool_units. Receiving
 * updates inventory_item.metadata.landed_per_qp on each restock with
 * the latest weighted-shipping spread, so any prior owner-stores price
 * goes stale the moment receiving lands a new cost.
 *
 * Why only Owner Stores: Distro + default tier prices are operator-set
 * static tables — they don't change when cost changes. Owner Stores is
 * the only mode whose price is COMPUTED from cost, so it's the only one
 * that needs auto-refresh.
 *
 * Best-effort + non-blocking — receiving succeeded; if the recompute
 * fails the operator can re-Apply manually from settings.
 */
export default async function receivingToOwnerPrices({
  event,
  container,
}: SubscriberArgs<{ history_id?: string; profile_key?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const profileKey = event?.data?.profile_key
  if (!profileKey) {
    logger.warn(`[receiving-to-owner-prices] no profile_key in event; skipping`)
    return
  }

  /* The received profile's markup setting (priceTables.owner). CBD and
   * CBG flower share flower's per-QP markup + PriceList; THC-P has none
   * (case-pack branch uses its own pricing model). */
  const profile = await findProfile(container, profileKey)
  const table = profile ? tableFor(profile, "owner") : null
  if (!table) {
    logger.info(`[receiving-to-owner-prices] profile "${profileKey}" has no owner markup configured; skipping`)
    return
  }

  try {
    const result = await applyOwnerPrices(container, table)
    if (!result.ok) {
      logger.warn(`[receiving-to-owner-prices] apply ${table} failed: ${result.error}`)
      return
    }
    const propagated = result.added + result.updated
    logger.info(
      `[receiving-to-owner-prices] ${table}: ${propagated} prices refreshed · ${result.skipped} skipped (history ${event?.data?.history_id})`,
    )
  } catch (e: any) {
    /* Non-blocking — receiving already succeeded. The operator can
     * re-Apply manually from Settings → Owner Markup if this happens. */
    logger.warn(`[receiving-to-owner-prices] unexpected error: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: "receiving.saved",
}

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import {
  applyGroupPrices,
  settingKeyFor,
  type GroupKey,
  type GroupScope,
} from "../lib/group-prices-apply"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"

/**
 * Auto-propagate customer-group prices (Distro / Chain of Stores /
 * Low Volume) after a successful receiving.
 *
 * Before this subscriber: default prices got stamped directly onto the
 * new variant, and owner_stores was auto-refreshed via a companion
 * subscriber, but customer-group PriceLists (distro / tier_2 / tier_3)
 * required the operator to open MBS Settings and click Save & Apply
 * on each mode's tab. Every new strain = 3 extra clicks. Miss one and
 * distro / chain-of-stores / low-volume buyers see the default price
 * on the new strain (silent overpay for the buyer, silent margin loss
 * for the operator) until someone notices.
 *
 * Behavior:
 *   - Fires on `receiving.saved` alongside receiving-to-owner-prices.
 *   - Maps profile_key → GroupScope (flower / preroll / thcp_flower).
 *   - For each of the three groups, checks if the settings key exists
 *     first — modes with no configured prices (e.g. THC-P Flower has
 *     no tier_2 / tier_3 tables today) are silently skipped so the
 *     log doesn't flood with expected "not configured" warnings.
 *   - Runs all three in parallel; each is independent + best-effort.
 *   - Receiving already succeeded — this never fails-noisy back to the
 *     operator. Failures log a warning; operator can re-Apply manually
 *     from Settings if a mode falls behind.
 */
export default async function receivingToGroupPrices({
  event,
  container,
}: SubscriberArgs<{ history_id?: string; profile_key?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)

  const profileKey = event?.data?.profile_key
  if (!profileKey) {
    logger.warn(`[receiving-to-group-prices] no profile_key in event; skipping`)
    return
  }

  const scope: GroupScope | null =
    profileKey === "flower" ? "flower"
    : profileKey === "pre-roll" ? "preroll"
    : profileKey === "flower-thc-p" ? "thcp_flower"
    : null
  if (!scope) {
    logger.info(`[receiving-to-group-prices] profile "${profileKey}" has no group-prices mapping; skipping`)
    return
  }

  const groups: GroupKey[] = ["distro", "tier_2", "tier_3"]

  /* Filter to modes whose settings key is actually populated so we
   * don't warn for expected "not configured" cases. THC-P Flower
   * today has only distro configured; tier_2/tier_3 skip silently. */
  const configured: GroupKey[] = []
  for (const group of groups) {
    const key = settingKeyFor(scope, group)
    const value = await settings.getSetting(key).catch(() => null)
    if (value != null) configured.push(group)
  }

  if (configured.length === 0) {
    logger.info(`[receiving-to-group-prices] no group-price tables configured for scope "${scope}"; skipping`)
    return
  }

  /* Fan out in parallel. Each apply is independent — a distro failure
   * doesn't block tier_2/tier_3. Log per-mode outcome so operators can
   * inspect via Railway logs when a mode falls behind. */
  const outcomes = await Promise.allSettled(
    configured.map((group) => applyGroupPrices(container, scope, group)),
  )
  for (let i = 0; i < configured.length; i += 1) {
    const group = configured[i]
    const outcome = outcomes[i]
    if (outcome.status === "rejected") {
      logger.warn(
        `[receiving-to-group-prices] ${scope}/${group} threw: ${outcome.reason?.message ?? outcome.reason}`,
      )
      continue
    }
    const result = outcome.value
    if (!result.ok) {
      logger.warn(`[receiving-to-group-prices] ${scope}/${group} failed: ${result.error}`)
      continue
    }
    const s = result.summary!
    logger.info(
      `[receiving-to-group-prices] ${scope}/${group}: ${s.added + s.updated} propagated · ${s.skipped} skipped (history ${event?.data?.history_id})`,
    )
  }
}

export const config: SubscriberConfig = {
  event: "receiving.saved",
}

import type { ReceivingProfile } from "./receiving-profiles"

/**
 * Price levels (zero-code categories, Phase 2).
 *
 * Every buyer is priced at one level. Each category profile names the
 * mbs-settings table it uses at each level: `tierPricesSettingKey` for
 * Default, `priceTables` for the rest. The applies, the receiving
 * subscribers and the store tier-prices route all read tables through
 * here, so a new category gets prices by naming its tables in MBS
 * Settings → Categories.
 */

export type GroupLevel = "tier_2" | "tier_3" | "distro"
export type PriceLevel = "default" | GroupLevel | "owner"

export const GROUP_LEVELS: GroupLevel[] = ["distro", "tier_2", "tier_3"]

/** Customer group + PriceList per group level. One PriceList per level
 *  holds every category's prices for it. */
export const GROUP_LEVEL_CONFIG: Record<GroupLevel, {
  groupName: string
  priceListTitle: string
  description: string
}> = {
  distro: {
    groupName: "distro",
    priceListTitle: "Distro Pricing",
    description: "Distributor (B2B distro) selling prices. Scoped to the `distro` customer group.",
  },
  tier_2: {
    groupName: "tier_2",
    priceListTitle: "Tier 2 Pricing",
    description: "Tier 2 wholesale selling prices. Scoped to the `tier_2` customer group.",
  },
  tier_3: {
    groupName: "tier_3",
    priceListTitle: "Tier 3 Pricing",
    description: "Tier 3 wholesale selling prices. Scoped to the `tier_3` customer group.",
  },
}

export const OWNER_LEVEL_CONFIG = {
  groupName: "owner_stores",
  priceListTitle: "Owner Stores Pricing",
  description: "Operator's own retail stores — landed cost + admin-set markup. Scoped to the `owner_stores` customer group.",
}

/** The table a profile uses at a level, or null when it has none. */
export function tableFor(profile: ReceivingProfile, level: PriceLevel): string | null {
  if (level === "default") return profile.tierPricesSettingKey ?? null
  return profile.priceTables?.[level] ?? null
}

/** Profiles that read `tableKey` at `level`. */
export function profilesForTable(profiles: ReceivingProfile[], level: PriceLevel, tableKey: string): ReceivingProfile[] {
  return profiles.filter((p) => tableFor(p, level) === tableKey)
}

/**
 * The table a buyer's pricing mode reads for a profile's display prices
 * ("From $X" on the home page). Owner Stores prices are computed per
 * variant from landed cost, so those buyers see the Default table there;
 * their real price still comes from the Owner Stores PriceList.
 */
export function displayTableFor(profile: ReceivingProfile, pricingMode: string | null): string | null {
  const level: PriceLevel =
    pricingMode === "tier_2" || pricingMode === "tier_3" || pricingMode === "distro" ? pricingMode : "default"
  return tableFor(profile, level) ?? tableFor(profile, "default")
}

/* Pre-registry callers (admin pages, older scripts) name a whole branch
 * of profiles with `scope`. Each maps to the profile whose tables it
 * meant; the applies then cover every profile sharing those tables. */
const LEGACY_SCOPE_PROFILE: Record<string, string> = {
  flower: "flower",
  preroll: "pre-roll",
  flower_cbg: "flower-cbg",
}

/** Resolve a request's table: an explicit `table` wins, else the legacy
 *  `scope` is mapped through its profile. */
export function resolveRequestTable(
  profiles: ReceivingProfile[],
  level: PriceLevel,
  body: { table?: unknown; scope?: unknown },
): { table: string } | { error: string } {
  if (typeof body.table === "string" && body.table.trim()) return { table: body.table.trim() }
  const scope = typeof body.scope === "string" ? body.scope : "flower"
  const profileKey = LEGACY_SCOPE_PROFILE[scope]
  if (!profileKey) return { error: `Unknown scope "${scope}". Send { table } with an mbs-settings price table key.` }
  const profile = profiles.find((p) => p.key === profileKey)
  const table = profile ? tableFor(profile, level) : null
  if (!table) return { error: `"${scope}" has no ${level} price table configured in MBS Settings → Categories.` }
  return { table }
}

import type { ProfileKey, ReceivingProfile } from "./receiving-profiles"
import { loadProfiles, resolveProfileCategories } from "./profile-store"

/**
 * Which products a price table is allowed to touch.
 *
 * Every price apply (default tier prices, customer-group prices, owner
 * prices) matches variants by `metadata.tier_key` + `size_key`. Those
 * keys repeat across branches: CBD Classic and CBG Classic are both
 * `classic`. Matching on keys alone let the CBD table reprice CBG
 * products and the reverse. Each apply now also requires the product to
 * sit under one of its receiving profiles' categories.
 *
 * The categories come from the receiving profiles (parent category, or
 * the profile's subcategory root when it has one), loaded from MBS
 * Settings → Categories, so a table covers exactly the products its
 * profiles receive.
 */

/** Customer-group and owner price tables are shared across profiles:
 *  CBG has no group tables of its own and uses the CBD Flower ones. */
export type SharedPriceScope = "flower" | "preroll"

export const SHARED_SCOPE_PROFILES: Record<SharedPriceScope, ProfileKey[]> = {
  flower: ["flower", "flower-cbd", "flower-cbg"],
  preroll: ["pre-roll"],
}

/** The shared scope a receiving profile's group/owner prices live in,
 *  or null when it has none (THC-P). */
export function sharedScopeForProfile(profileKey: string): SharedPriceScope | null {
  for (const [scope, keys] of Object.entries(SHARED_SCOPE_PROFILES)) {
    if ((keys as string[]).includes(profileKey)) return scope as SharedPriceScope
  }
  return null
}

/** Category ids for the profiles whose default selling prices come from
 *  `settingKey`. */
export async function categoryIdsForTierSetting(container: any, query: any, settingKey: string): Promise<Set<string>> {
  const { profiles } = await loadProfiles(container)
  return categoryIdsForProfiles(query, profiles.filter((p) => p.tierPricesSettingKey === settingKey))
}

/** Category ids for the profiles sharing a group/owner price scope. */
export async function categoryIdsForSharedScope(container: any, query: any, scope: SharedPriceScope): Promise<Set<string>> {
  const { profiles } = await loadProfiles(container)
  const keys = SHARED_SCOPE_PROFILES[scope] as string[]
  return categoryIdsForProfiles(query, profiles.filter((p) => keys.includes(p.key)))
}

/** Ids of every category the given profiles receive into: each live
 *  sub-category (resolveProfileCategories, the same list receiving uses)
 *  and anything under it. */
export async function categoryIdsForProfiles(
  query: any,
  profiles: ReceivingProfile[],
): Promise<Set<string>> {
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "parent_category_id"],
  })
  const children = new Map<string, string[]>()
  for (const c of (data ?? []) as Array<{ id: string; parent_category_id: string | null }>) {
    if (!c.parent_category_id) continue
    const list = children.get(c.parent_category_id) ?? []
    list.push(c.id)
    children.set(c.parent_category_id, list)
  }

  const ids = new Set<string>()
  for (const profile of profiles) {
    const { profile: resolved } = await resolveProfileCategories(query, profile)
    const stack = resolved.subcategories.map((s) => s.id)
    while (stack.length > 0) {
      const id = stack.pop()!
      if (ids.has(id)) continue
      ids.add(id)
      stack.push(...(children.get(id) ?? []))
    }
  }
  return ids
}

/** True when any of the product's categories is in `ids`. */
export function productInCategories(
  product: { categories?: Array<{ id?: string | null } | null> | null } | null | undefined,
  ids: Set<string>,
): boolean {
  return (product?.categories ?? []).some((c) => !!c?.id && ids.has(String(c.id)))
}

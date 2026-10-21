import { PROFILES, type ProfileKey } from "./receiving-profiles"

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
 * the profile's subcategory root when it has one), so a table covers
 * exactly the products its profiles receive.
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

/** Profiles whose default selling prices come from `settingKey`. */
export function profileKeysForTierSetting(settingKey: string): ProfileKey[] {
  return Object.values(PROFILES)
    .filter((p) => p.tierPricesSettingKey === settingKey)
    .map((p) => p.key)
}

/** Ids of every category under the given profiles' subcategory roots. */
export async function categoryIdsForProfiles(
  query: any,
  profileKeys: ProfileKey[],
): Promise<Set<string>> {
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id"],
  })
  const cats = (data ?? []) as Array<{ id: string; name: string; handle: string; parent_category_id: string | null }>
  const children = new Map<string, string[]>()
  for (const c of cats) {
    if (!c.parent_category_id) continue
    const list = children.get(c.parent_category_id) ?? []
    list.push(c.id)
    children.set(c.parent_category_id, list)
  }

  const ids = new Set<string>()
  for (const key of profileKeys) {
    const profile = PROFILES[key]
    if (!profile) continue
    /* Same root resolution as buildSaveContext in receiving-save.ts. */
    const parent = cats.find((c) => c.name === profile.parentCategoryName && !c.parent_category_id)
    if (!parent) continue
    const root = profile.subcategoryParentHandle
      ? cats.find((c) => c.handle === profile.subcategoryParentHandle)
      : parent
    if (!root) continue
    const stack = [root.id]
    while (stack.length > 0) {
      for (const child of children.get(stack.pop()!) ?? []) {
        if (ids.has(child)) continue
        ids.add(child)
        stack.push(child)
      }
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

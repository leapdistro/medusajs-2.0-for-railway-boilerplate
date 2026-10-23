import type { ReceivingProfile } from "./receiving-profiles"
import { loadProfiles, resolveProfileCategories, type ResolvedSubcategory } from "./profile-store"
import { profilesForTable, type PriceLevel } from "./price-levels"

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
 * A table's profiles are the ones that name it at that level (MBS
 * Settings → Categories, lib/price-levels.ts), so a table covers exactly
 * the products its profiles receive.
 */

export type ScopedCategory = { profile: ReceivingProfile; subcategory: ResolvedSubcategory }

export type TableScope = {
  profiles: ReceivingProfile[]
  /** Every category the profiles receive into: each live sub-category
   *  and anything under it, mapped to the profile + sub-category. */
  categories: Map<string, ScopedCategory>
}

/** The profiles and categories priced from `tableKey` at `level`. */
export async function scopeForTable(
  container: any,
  query: any,
  level: PriceLevel,
  tableKey: string,
): Promise<TableScope> {
  const { profiles } = await loadProfiles(container)
  const matched = profilesForTable(profiles, level, tableKey)
  return { profiles: matched, categories: await categoriesForProfiles(query, matched) }
}

/** Category ids for the profiles whose default selling prices come from
 *  `settingKey`. */
export async function categoryIdsForTierSetting(container: any, query: any, settingKey: string): Promise<Set<string>> {
  const { categories } = await scopeForTable(container, query, "default", settingKey)
  return new Set(categories.keys())
}

async function categoriesForProfiles(
  query: any,
  profiles: ReceivingProfile[],
): Promise<Map<string, ScopedCategory>> {
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

  const out = new Map<string, ScopedCategory>()
  for (const profile of profiles) {
    const { profile: resolved } = await resolveProfileCategories(query, profile)
    for (const subcategory of resolved.subcategories) {
      const stack = [subcategory.id]
      while (stack.length > 0) {
        const id = stack.pop()!
        if (out.has(id)) continue
        out.set(id, { profile, subcategory })
        stack.push(...(children.get(id) ?? []))
      }
    }
  }
  return out
}

/** The first of the product's categories inside the scope, or null. */
export function scopedCategoryOf(
  product: { categories?: Array<{ id?: string | null } | null> | null } | null | undefined,
  categories: Map<string, ScopedCategory>,
): ScopedCategory | null {
  for (const c of product?.categories ?? []) {
    const hit = c?.id ? categories.get(String(c.id)) : undefined
    if (hit) return hit
  }
  return null
}

/** True when any of the product's categories is in `ids`. */
export function productInCategories(
  product: { categories?: Array<{ id?: string | null } | null> | null } | null | undefined,
  ids: Set<string> | Map<string, unknown>,
): boolean {
  return (product?.categories ?? []).some((c) => !!c?.id && ids.has(String(c.id)))
}

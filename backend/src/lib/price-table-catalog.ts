import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import { loadProfiles, resolveProfileCategories } from "./profile-store"
import { PRICE_LEVEL_LABELS, PRICE_LEVELS, tableFor, type PriceLevel } from "./price-levels"

/**
 * What MBS Settings shows on each price tab: one section per table a
 * category names at that level, with the sub-categories and sizes that
 * table prices (live from Medusa, same list receiving uses) and the
 * saved value. Archived categories are left out; a table only they use
 * is not shown.
 */

export type CatalogRow = { key: string; label: string; sizes: Array<{ key: string; label: string; multiplier: number }> }

export type CatalogTable = {
  key: string
  categories: Array<{ key: string; name: string }>
  /** Grid tables: sub-category × size. */
  rows: CatalogRow[]
  /** Owner markup: the stock unit the markup is per. */
  unit?: string
  value: unknown
}

export type CatalogLevel = { level: PriceLevel; label: string; tables: CatalogTable[] }

export async function priceTableCatalog(container: any): Promise<CatalogLevel[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const { profiles } = await loadProfiles(container)
  const active = profiles.filter((p) => !p.archived)

  const resolved = new Map(
    await Promise.all(active.map(async (p) => [p.key, (await resolveProfileCategories(query, p)).profile] as const)),
  )

  const out: CatalogLevel[] = []
  for (const level of PRICE_LEVELS) {
    const tables: CatalogTable[] = []
    for (const profile of active) {
      const key = tableFor(profile, level)
      if (!key) continue
      let table = tables.find((t) => t.key === key)
      if (!table) {
        table = { key, categories: [], rows: [], value: await settings.getSetting(key).catch(() => null) }
        tables.push(table)
      }
      table.categories.push({ key: profile.key, name: profile.displayName })
      if (level === "owner") {
        table.unit ??= profile.unitLabel.singular
        continue
      }
      for (const sub of resolved.get(profile.key)?.subcategories ?? []) {
        let row = table.rows.find((r) => r.key === sub.key)
        if (!row) {
          row = { key: sub.key, label: sub.label, sizes: [] }
          table.rows.push(row)
        }
        for (const v of sub.variants) {
          if (!row.sizes.some((s) => s.key === v.sizeKey)) {
            row.sizes.push({ key: v.sizeKey, label: v.label, multiplier: v.multiplier })
          }
        }
      }
    }
    out.push({ level, label: PRICE_LEVEL_LABELS[level], tables })
  }
  return out
}

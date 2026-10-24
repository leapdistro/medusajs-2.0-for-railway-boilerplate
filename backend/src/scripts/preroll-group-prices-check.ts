import { applyGroupPrices } from "../lib/group-prices-apply"
import { loadProfiles } from "../lib/profile-store"
import { GROUP_LEVELS, tableFor } from "../lib/price-levels"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"

/**
 * Read-only. Lists the stored category profiles, then for Pre-Rolls
 * dry-runs each customer-group price apply: every price the table says
 * a pre-roll variant should have, next to what that group's PriceList
 * holds now. Nothing is written.
 *
 *   npx medusa exec ./src/scripts/preroll-group-prices-check.ts
 */
export default async function prerollGroupPricesCheck({ container }: { container: any }) {
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const { profiles, source } = await loadProfiles(container)
  console.log(`profiles (${source}):`)
  for (const p of profiles) {
    console.log(`  ${p.key} · ${p.displayName}${p.archived ? " · ARCHIVED" : ""} · receives in ${p.inputUnitLabel.plural} · ${p.pricingModel} ${p.tierPricesSettingKey ?? ""} · cannabinoids ${p.fields.cannabinoids} · upc ${p.fields.upc}`)
  }

  const preroll = profiles.find((p) => p.key === "pre-roll")
  if (!preroll) { console.log("no pre-roll profile"); return }
  for (const group of GROUP_LEVELS) {
    const table = tableFor(preroll, group)
    if (!table) { console.log(`\n${group}: no table`); continue }
    const value = await settings.getSetting(table).catch(() => null)
    console.log(`\n${group} · ${table} = ${JSON.stringify(value)}`)
    if (value == null) continue
    const r = await applyGroupPrices(container, table, group, { dryRun: true })
    if (!r.ok) { console.log(`  apply dry run failed: ${r.error}`); continue }
    const s = r.summary!
    console.log(`  price list ${s.price_list_id ?? "NONE"} · scanned ${s.scanned} · would add ${s.added} · update ${s.updated} · skip ${s.skipped} ${JSON.stringify(s.skip_reasons)}`)
    const wrong = (r.planned ?? []).filter((p) => p.current !== p.amount)
    for (const p of wrong.slice(0, 15)) console.log(`  ${p.variant_id}: has ${p.current ?? "nothing"}, table says ${p.amount}`)
    if (wrong.length === 0) console.log(`  ✓ all ${r.planned?.length ?? 0} planned prices already in place`)
  }
}

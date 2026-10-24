import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { invoicePrompt } from "../lib/ai-extraction"
import { loadProfiles, normalizeProfileList, resolveProfileCategories } from "../lib/profile-store"
import { PROFILES } from "../lib/receiving-profiles"
import { cannabinoidField } from "../admin/lib/cannabinoids"

/**
 * Read-only. Phase 4b moved the Receiving page's CBD/CBG buttons, the %
 * column, the COA reader's target and the invoice unit into each
 * category's settings. Checks they come out exactly as the code had
 * them, both from the built-in profiles (today) and from a list saved
 * by the Categories tab, with or without the new settings in it.
 *
 *   npx medusa exec ./src/scripts/category-settings-dry-run.ts
 */

/* What the Receiving page and Pre-Rolls page had in code before 4b. */
const BEFORE_BUTTONS = [
  { profileKey: "flower-cbd", label: "CBD", settingsKey: "flower_tier_prices", draftKind: "flower-cbd", pct: "CBD %", field: "cbdPercent", coa: "CBD" },
  { profileKey: "flower-cbg", label: "CBG", settingsKey: "flower_cbg_prices", draftKind: "flower-cbg", pct: "CBG %", field: "cbgPercent", coa: "CBG" },
]
const BEFORE_PREROLL = { pct: "CBD %", field: "cbdPercent" }

export default async function categorySettingsDryRun({ container }: { container: any }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  let bad = 0
  const check = (ok: boolean, what: string) => {
    if (!ok) bad++
    console.log(`  ${ok ? "✓" : "✗"} ${what}`)
  }

  const { profiles, source } = await loadProfiles(container)
  /* What GET /admin/mbs/category-profiles hands the pages. */
  const served = await Promise.all(profiles.map(async (p) => (await resolveProfileCategories(query, p)).linked))
  /* A list the Categories tab saved before 4b: same, minus the new fields. */
  const savedOld = normalizeProfileList(
    served.map(({ primaryCannabinoid, invoiceUpload, ...rest }) => rest),
  ).profiles.map((p) => ({
    ...p,
    primaryCannabinoid: p.primaryCannabinoid ?? PROFILES[p.key]?.primaryCannabinoid,
    invoiceUpload: p.invoiceUpload ?? PROFILES[p.key]?.invoiceUpload,
  }))
  /* A list saved after 4b: round-trips through validation. */
  const savedNew = normalizeProfileList(served).profiles

  for (const [name, list] of [[`today (${source})`, served], ["saved before 4b", savedOld], ["saved after 4b", savedNew]] as const) {
    console.log(`\n${name}:`)
    for (const p of list) console.log(`    ${p.key}: main ${p.primaryCannabinoid ?? "-"} · invoice upload ${p.invoiceUpload ?? "-"}${p.archived ? " · archived" : ""}`)
    /* The Receiving page's buttons, built the way the page builds them. */
    const buttons = list
      .filter((p: any) => p.invoiceUpload && !p.archived)
      .map((p: any) => {
        const f = cannabinoidField(p.primaryCannabinoid)
        return {
          profileKey: p.key,
          label: p.primaryCannabinoid ?? p.displayName,
          settingsKey: p.tierPricesSettingKey ?? null,
          draftKind: p.key,
          pct: f.label,
          field: f.rowField,
          coa: p.primaryCannabinoid,
        }
      })
    check(JSON.stringify(buttons) === JSON.stringify(BEFORE_BUTTONS), `Receiving page buttons: ${buttons.map((b) => `${b.label} (${b.profileKey}, ${b.settingsKey}, ${b.pct} → ${b.field}, COA ${b.coa})`).join(" · ")}`)
    const pre = list.find((p: any) => p.key === "pre-roll")
    const pf = cannabinoidField(pre?.primaryCannabinoid)
    check(pf.label === BEFORE_PREROLL.pct && pf.rowField === BEFORE_PREROLL.field, `Pre-Rolls: ${pf.label} → ${pf.rowField}`)
  }

  console.log("\nInvoice reader prompt:")
  const lb = profiles.find((p) => p.key === "flower-cbd")!.inputUnitLabel
  check(invoicePrompt(lb) === invoicePrompt(undefined), `flower (${lb.singular}) gets the original prompt word for word`)
  const boxes = invoicePrompt({ singular: "box", plural: "boxes" })
  check(boxes !== invoicePrompt(undefined) && !/POUNDS/.test(boxes) && /BOXES/.test(boxes), "a box category gets quantities and prices in boxes")

  console.log(bad === 0 ? "\nRESULT: identical to before 4b." : `\nRESULT: ${bad} difference(s), see ✗ above.`)
}

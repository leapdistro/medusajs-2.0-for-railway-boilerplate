import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { invoicePrompt } from "../lib/ai-extraction"
import { loadProfiles, normalizeProfileList, resolveProfileCategories } from "../lib/profile-store"
import { PROFILES } from "../lib/receiving-profiles"
import { cannabinoidField, otherCannabinoidColumns } from "../admin/lib/cannabinoids"

/**
 * Read-only. Phase 4b moved the Receiving page's CBD/CBG buttons, the %
 * column, the COA reader's target and the invoice unit into each
 * category's settings, and then the D9 % / THCa % columns too ("also
 * record"). Checks they come out exactly as the code had them, both from
 * the built-in profiles (today) and from a list saved by the Categories
 * tab, with or without the new settings in it.
 *
 *   npx medusa exec ./src/scripts/category-settings-dry-run.ts
 */

/* What the Receiving page and Pre-Rolls page had in code before 4b. */
/* Flower always had a required D9 % text box after the main %. */
const FLOWER_OTHERS = "D9 % → d9Percent (required, takes ND)"
const BEFORE_BUTTONS = [
  { profileKey: "flower-cbd", label: "CBD", settingsKey: "flower_tier_prices", draftKind: "flower-cbd", pct: "CBD %", field: "cbdPercent", coa: "CBD", others: FLOWER_OTHERS },
  { profileKey: "flower-cbg", label: "CBG", settingsKey: "flower_cbg_prices", draftKind: "flower-cbg", pct: "CBG %", field: "cbgPercent", coa: "CBG", others: FLOWER_OTHERS },
]
/* Pre-Rolls: required D9 %, then THCa % (optional, hidden if THCa is main). */
const BEFORE_PREROLL = { pct: "CBD %", field: "cbdPercent", others: "D9 % → d9Percent (required, takes ND) · THCa % → thcaPercent (optional)" }

const describeOthers = (p: any) => otherCannabinoidColumns(p?.primaryCannabinoid, p?.otherCannabinoids)
  .map((o) => `${o.label} → ${o.rowField} (${o.required ? "required" : "optional"}${o.allowsNd ? ", takes ND" : ""})`)
  .join(" · ")

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
    served.map(({ primaryCannabinoid, invoiceUpload, otherCannabinoids, ...rest }) => rest),
  ).profiles.map((p) => ({
    ...p,
    primaryCannabinoid: p.primaryCannabinoid ?? PROFILES[p.key]?.primaryCannabinoid,
    invoiceUpload: p.invoiceUpload ?? PROFILES[p.key]?.invoiceUpload,
    otherCannabinoids: p.otherCannabinoids ?? PROFILES[p.key]?.otherCannabinoids,
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
          others: describeOthers(p),
        }
      })
    check(JSON.stringify(buttons) === JSON.stringify(BEFORE_BUTTONS), `Receiving page buttons: ${buttons.map((b) => `${b.label} (${b.profileKey}, ${b.settingsKey}, ${b.pct} → ${b.field}, COA ${b.coa}; also ${b.others})`).join(" · ")}`)
    const pre = list.find((p: any) => p.key === "pre-roll")
    const pf = cannabinoidField(pre?.primaryCannabinoid)
    const po = describeOthers(pre)
    check(pf.label === BEFORE_PREROLL.pct && pf.rowField === BEFORE_PREROLL.field && po === BEFORE_PREROLL.others, `Pre-Rolls: ${pf.label} → ${pf.rowField}; also ${po}`)
  }

  console.log("\nSettings checks:")
  const base = served.find((p: any) => p.key === "flower-cbd")
  const tryOthers = (primaryCannabinoid: string, otherCannabinoids: any[]) =>
    normalizeProfileList([{ ...base, primaryCannabinoid, otherCannabinoids }])
  check(tryOthers("CBD", [{ cannabinoid: "CBD", required: true }]).profiles.length === 0, "the main cannabinoid can't also be an other one")
  check(tryOthers("CBD", [{ cannabinoid: "D9", required: true }, { cannabinoid: "D9", required: false }]).profiles.length === 0, "an other cannabinoid can't be listed twice")
  check(tryOthers("CBD", [{ cannabinoid: "CBN", required: true }]).profiles.length === 0, "an unknown cannabinoid is refused")
  const d9Main = tryOthers("D9", [{ cannabinoid: "THC-A", required: false }]).profiles[0]
  const d9f = cannabinoidField(d9Main?.primaryCannabinoid)
  check(d9f.label === "D9 %" && d9f.rowField === "d9Percent" && describeOthers(d9Main) === "THCa % → thcaPercent (optional)", `D9 as the main one: ${d9f.label} → ${d9f.rowField}; also ${describeOthers(d9Main)}`)
  const none = tryOthers("CBD", []).profiles[0]
  check(none?.otherCannabinoids?.length === 0, "an empty list saves as empty (no D9 column), not back to the built-in")

  console.log("\nInvoice reader prompt:")
  const lb = profiles.find((p) => p.key === "flower-cbd")!.inputUnitLabel
  check(invoicePrompt(lb) === invoicePrompt(undefined), `flower (${lb.singular}) gets the original prompt word for word`)
  const boxes = invoicePrompt({ singular: "box", plural: "boxes" })
  check(boxes !== invoicePrompt(undefined) && !/POUNDS/.test(boxes) && /BOXES/.test(boxes), "a box category gets quantities and prices in boxes")

  console.log(bad === 0 ? "\nRESULT: identical to before 4b." : `\nRESULT: ${bad} difference(s), see ✗ above.`)
}

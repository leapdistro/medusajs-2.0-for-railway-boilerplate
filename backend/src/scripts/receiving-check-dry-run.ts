import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { buildSaveContext, checkRow, type SaveRow, type TierPriceMap } from "../lib/receiving-save"
import { loadProfiles } from "../lib/profile-store"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * Read-only. Replays the most recent receivings through the save
 * route's new up-front check (checkRow) and its already-saved lookup:
 * every row they saved should now check as a restock of the same
 * product, and re-sending the invoice should skip every saved row.
 * Nothing is written.
 *
 *   npx medusa exec ./src/scripts/receiving-check-dry-run.ts
 */
export default async function receivingCheckDryRun({ container }: { container: any }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const { profiles } = await loadProfiles(container)

  const records = await history.listReceivingRecords({}, { take: 6, order: { created_at: "DESC" } })
  let bad = 0
  for (const rec of records as any[]) {
    const lines = (rec.line_results ?? []) as any[]
    const saved = lines.filter((l) => l.action === "created" || l.action === "restocked")
    /* Which profile received it: the one whose sub-category keys cover
     * the record's tiers and whose root matches its category path. */
    const path0 = saved[0]?.categoryPath ?? []
    const profile = profiles.find((p) =>
      !p.archived &&
      p.parentCategoryName === path0[0] &&
      (p.qboCategoryBranch ?? null) === (path0.length > 2 ? path0[1] : null),
    )
    console.log(`\n${rec.invoice_number} · ${rec.supplier?.name ?? "?"} · ${rec.invoice_date} · ${saved.length}/${lines.length} saved lines · profile ${profile?.key ?? "NONE"}`)
    if (!profile || saved.length === 0) continue

    const tierPrices = profile.pricingModel === "tier" && profile.tierPricesSettingKey
      ? ((await settings.getSetting(profile.tierPricesSettingKey)) as TierPriceMap)
      : ({} as TierPriceMap)
    const ctx = await buildSaveContext(container, 0, tierPrices, null, profile)

    for (const l of saved) {
      const row: SaveRow = {
        strainName: l.strainName,
        quantity: 1,
        unitPrice: 1,
        sellPrice: l.inputUnitSellPrice ?? 1,
        tier: l.tier,
        strainType: "Hybrid",
        bestFor: "day",
        effects: [],
        coaUrl: "dry-run",
        coaOriginalName: null,
        thcaPercent: null,
        totalCannabinoidsPercent: null,
      }
      const c = await checkRow(container, row, ctx)
      const p = c.plan
      const ok = p?.kind === "restock" && p.productId === l.productId
      if (!ok) bad++
      console.log(`  ${ok ? "✓" : "✗"} ${l.strainName} [${l.tier}] → ${p ? `${p.kind}${p.kind === "restock" ? ` ${p.productId === l.productId ? "same product" : `DIFFERENT product ${p.productId} (was ${l.productId})`}` : ""}` : `error: ${c.error}`}`)
    }

    /* The route's lookup: same number + same supplier → skip those lines. */
    const norm = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase()
    const sameNumber = await history.listReceivingRecords({ invoice_number: [rec.invoice_number] }, { take: 50, order: { created_at: "DESC" } })
    const match = (sameNumber as any[]).find((r) => norm(r.supplier?.name) === norm(rec.supplier?.name))
    const keys = new Set(((match?.line_results ?? []) as any[])
      .filter((l) => l.action === "created" || l.action === "restocked")
      .map((l) => `${norm(l.strainName)}|${l.tier ?? ""}`))
    const skipped = saved.filter((l) => keys.has(`${norm(l.strainName)}|${l.tier ?? ""}`)).length
    console.log(`  re-save of this invoice: ${skipped}/${saved.length} saved rows skipped${(sameNumber as any[]).length > 1 ? ` (${(sameNumber as any[]).length} records share this invoice number)` : ""}`)
    if (skipped !== saved.length) bad++
  }
  logger.info(bad === 0 ? "RESULT: every saved row checks as a restock of its own product and would be skipped on re-save." : `RESULT: ${bad} problem(s), see ✗ above.`)
}

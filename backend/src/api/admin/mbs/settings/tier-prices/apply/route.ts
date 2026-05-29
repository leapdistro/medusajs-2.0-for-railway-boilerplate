import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/tier-prices/apply
 *
 * Bulk-propagates the current mbs-settings tier prices to every
 * "tier_linked" variant. Lets the operator change a tier price in
 * settings and push it to every existing variant in one click —
 * without that, edits in MBS Settings would only affect FUTURE
 * receivings.
 *
 * Body: { scope: "flower" | "preroll" }
 *   - "flower":  walks variants whose metadata.tier_key is one of
 *     classic / exotic / super / snow / rapper. Reads from
 *     `flower_tier_prices` setting.
 *   - "preroll": walks every other tier_linked variant (i.e., the
 *     pre-roll subcategory keys — thc-a / hashholes / future subs).
 *     Reads from `pre_roll_tier_prices` setting.
 *
 * Match rule: variant.metadata.tier_linked === true AND tier_key +
 * size_key are present. Variants without tier_linked metadata are
 * treated as manual overrides — skipped. Variants where the resolved
 * setting value matches the current price are also skipped (no-op
 * write). Failed updates are logged but don't abort the loop.
 */

const FLOWER_TIERS = new Set(["classic", "exotic", "super", "snow", "rapper"])

type TierMap = Record<string, Record<string, number>>

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const pricingService: any = req.scope.resolve(Modules.PRICING)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const body = (req.body ?? {}) as { scope?: "flower" | "preroll" }
  const scope = body.scope ?? "flower"
  if (scope !== "flower" && scope !== "preroll") {
    res.status(400).json({ ok: false, message: `Invalid scope "${scope}" — must be "flower" or "preroll"` })
    return
  }

  const settingKey = scope === "flower" ? "flower_tier_prices" : "pre_roll_tier_prices"
  const prices = (await settings.getSetting(settingKey)) as TierMap | null
  if (!prices) {
    res.status(400).json({
      ok: false,
      message: `${settingKey} not configured — save prices in MBS Settings first.`,
    })
    return
  }

  /* Pull every variant + its USD price row. Filter on metadata
   * happens in memory (Medusa v2 graph filters don't support nested
   * jsonb predicates yet in this minor). */
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "metadata",
      "price_set.prices.id", "price_set.prices.amount", "price_set.prices.currency_code",
    ],
    filters: { deleted_at: null },
  })

  const updates: Array<{ id: string; amount: number }> = []
  let scanned = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    scanned += 1
    const meta = (v.metadata ?? {}) as Record<string, any>
    if (meta.tier_linked !== true) { bumpSkip("not_tier_linked"); continue }

    const tier = typeof meta.tier_key === "string" ? meta.tier_key : null
    const size = typeof meta.size_key === "string" ? meta.size_key : null
    if (!tier || !size) { bumpSkip("missing_tier_or_size_metadata"); continue }

    const isFlowerTier = FLOWER_TIERS.has(tier)
    if (scope === "flower" && !isFlowerTier) { bumpSkip("out_of_scope"); continue }
    if (scope === "preroll" && isFlowerTier) { bumpSkip("out_of_scope"); continue }

    const newPrice = prices?.[tier]?.[size]
    if (typeof newPrice !== "number" || !Number.isFinite(newPrice) || newPrice <= 0) {
      bumpSkip("no_matching_price_in_setting"); continue
    }

    const usd = (v.price_set?.prices ?? []).find((p: any) => p?.currency_code === "usd")
    if (!usd?.id) { bumpSkip("no_usd_price_row"); continue }

    if (Number(usd.amount) === newPrice) { bumpSkip("already_current"); continue }

    updates.push({ id: String(usd.id), amount: newPrice })
  }

  let updated = 0
  if (updates.length > 0) {
    try {
      await pricingService.updatePrices(updates)
      updated = updates.length
    } catch (e: any) {
      logger.warn(`[tier-prices/apply] batch update failed: ${e?.message}. Falling back to one-by-one.`)
      /* Fallback: try each separately so one bad row doesn't kill the batch. */
      for (const u of updates) {
        try {
          await pricingService.updatePrices([u])
          updated += 1
        } catch (e2: any) {
          logger.warn(`[tier-prices/apply] update ${u.id} failed: ${e2?.message}`)
          bumpSkip("update_failed")
        }
      }
    }
  }

  res.json({
    ok: true,
    summary: {
      scope,
      scanned,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"
import { scopedCategoryOf, scopeForTable } from "../../../../../../lib/price-scope"
import { resolveRequestTable } from "../../../../../../lib/price-levels"
import { loadProfiles } from "../../../../../../lib/profile-store"

/**
 * POST /admin/mbs/settings/tier-prices/apply
 *
 * Bulk-propagates the current mbs-settings tier prices to every variant
 * we can confidently identify — receiving-created, manually-created, or
 * legacy seed alike. Three resolution strategies, in order:
 *
 *   1. metadata.tier_key + metadata.size_key — fast path for variants
 *      that receiving stamped. Always wins when present.
 *   2. Category handle (variant.product.categories[].handle matches a
 *      setting key like "classic" / "thc-a") + size derived from the
 *      variant's SKU last segment OR variant.title. SKU convention is
 *      <cat-3>-<subcat-3>-...-<size> so size is the trailing segment
 *      (qp / half / lb / 30pk / 15pk / etc.).
 *   3. Same as #2 but with a small variant-title → size_key mapping
 *      (½→half, "30 ct Box"→30pk, etc.) for variants whose SKUs don't
 *      decode but whose option value follows the brand convention.
 *
 * Variants that none of the three can resolve are SKIPPED — we don't
 * have enough info to price them, so leaving them alone is correct.
 *
 * Body: { table, dryRun? } — `table` is the mbs-settings key holding
 *   default prices (a category profile's tierPricesSettingKey). Products
 *   of every profile naming that table are in scope, so flower_tier_prices
 *   covers THC-A and CBD flower. Legacy { scope: "flower" | "preroll" |
 *   "flower_cbg" } still works (lib/price-levels resolveRequestTable).
 *   dryRun returns `planned` (every price it would write) and writes
 *   nothing.
 */

type TierMap = Record<string, Record<string, number>>

/* Variant-title → size_key normalisation. Covers the brand's variant
 * labels that don't lowercase to a setting key directly. Kept short
 * intentionally — adding a new label here means a new brand variant
 * style was introduced (rare). */
const TITLE_TO_SIZE_KEY: Record<string, string> = {
  "½":           "half",
  "1/2":         "half",
  "half lb":     "half",
  "halflb":      "half",
  "30 ct box":   "30pk",
  "15 ct box":   "15pk",
  "30ct":        "30pk",
  "15ct":        "15pk",
}

function normalizeSizeFromTitle(rawTitle: string | null | undefined): string | null {
  if (!rawTitle) return null
  const t = String(rawTitle).toLowerCase().trim()
  if (TITLE_TO_SIZE_KEY[t]) return TITLE_TO_SIZE_KEY[t]
  return t // try a direct match against setting size keys
}

function sizeFromSku(sku: string | null | undefined): string | null {
  if (!sku) return null
  const parts = sku.toLowerCase().split("-").filter(Boolean)
  if (parts.length === 0) return null
  return parts[parts.length - 1] // last segment (qp / half / lb / 30pk / etc.)
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const pricingService: any = req.scope.resolve(Modules.PRICING)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const body = (req.body ?? {}) as { table?: unknown; scope?: unknown; dryRun?: unknown }
  const dryRun = body.dryRun === true
  const { profiles } = await loadProfiles(req.scope)
  const resolved = resolveRequestTable(profiles, "default", body)
  if ("error" in resolved) {
    res.status(400).json({ ok: false, message: resolved.error })
    return
  }
  const settingKey = resolved.table

  const prices = (await settings.getSetting(settingKey)) as TierMap | null
  if (!prices) {
    res.status(400).json({
      ok: false,
      message: `${settingKey} not configured — save prices in MBS Settings first.`,
    })
    return
  }

  const validTierKeys = new Set(Object.keys(prices))
  /* Only products received under this table's profiles: tier keys repeat
   * across branches (CBD and CBG both use `classic`), so the keys alone
   * would let one branch's table reprice the other. */
  const scope = await scopeForTable(req.scope, query, "default", settingKey)

  /* Pull every variant + product categories + USD price row. We can't
   * easily filter jsonb metadata in the graph layer in this Medusa minor,
   * so the strategy match runs in memory. ~hundreds of variants in
   * production catalogs — well within an in-memory pass budget. */
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "sku", "metadata",
      "options.option.title", "options.value",
      "product.categories.id", "product.categories.handle", "product.categories.name",
      "price_set.id", "price_set.prices.id", "price_set.prices.amount", "price_set.prices.currency_code",
    ],
    filters: { deleted_at: null },
  })

  const updates: Array<{ id: string; amount: number }> = []
  const planned: Array<{ variant_id: string; price_set_id: string; amount: number; current: number | null }> = []
  let scanned = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    scanned += 1
    const scoped = scopedCategoryOf(v.product, scope.categories)
    if (!scoped) { bumpSkip("out_of_scope_category"); continue }
    const meta = (v.metadata ?? {}) as Record<string, any>

    /* Resolve tier + size via the strategy ladder. */
    let tier: string | null = null
    let size: string | null = null

    /* Strategy 1 — metadata. */
    if (typeof meta.tier_key === "string" && typeof meta.size_key === "string") {
      tier = meta.tier_key
      size = meta.size_key
    }

    /* Strategy 2 + 3 — the product's sub-category key + SKU/title size.
     * The key, not the handle: CBD/CBG tier handles are cbd-classic /
     * cbg-exotic while the table is keyed by bare tier. */
    if (!tier || !size) {
      if (validTierKeys.has(scoped.subcategory.key)) {
        tier = scoped.subcategory.key
        /* Try SKU first (more reliable when present), then variant title /
         * Size option value. */
        const validSizes = new Set(Object.keys(prices[tier] ?? {}))
        const skuSize = sizeFromSku(v.sku)
        if (skuSize && validSizes.has(skuSize)) {
          size = skuSize
        } else {
          /* Pull a Size option value if present, else fall back to the
           * variant's own title. */
          const sizeOpt = ((v.options ?? []) as any[])
            .find((o) => String(o?.option?.title ?? "").toLowerCase() === "size")
          const candidate = sizeOpt?.value ?? v.title
          const normalized = normalizeSizeFromTitle(candidate)
          if (normalized && validSizes.has(normalized)) size = normalized
        }
      }
    }

    if (!tier || !size) { bumpSkip("unresolved_tier_or_size"); continue }
    if (!validTierKeys.has(tier)) { bumpSkip("out_of_scope_tier"); continue }

    const newPrice = prices?.[tier]?.[size]
    if (typeof newPrice !== "number" || !Number.isFinite(newPrice) || newPrice <= 0) {
      bumpSkip("no_price_for_tier_size"); continue
    }

    const usd = (v.price_set?.prices ?? []).find((p: any) => p?.currency_code === "usd")
    if (!usd?.id) { bumpSkip("no_usd_price_row"); continue }
    planned.push({
      variant_id: String(v.id),
      price_set_id: String(v.price_set?.id ?? ""),
      amount: newPrice,
      current: Number(usd.amount?.value ?? usd.amount?.numeric ?? usd.amount),
    })
    if (Number(usd.amount) === newPrice) { bumpSkip("already_current"); continue }

    updates.push({ id: String(usd.id), amount: newPrice })
  }

  if (dryRun) {
    res.json({
      ok: true,
      summary: { table: settingKey, scanned, updated: updates.length, skipped, skip_reasons: skipReasons },
      planned,
    })
    return
  }

  let updated = 0
  if (updates.length > 0) {
    try {
      await pricingService.updatePrices(updates)
      updated = updates.length
    } catch (e: any) {
      logger.warn(`[tier-prices/apply] batch update failed: ${e?.message}. Falling back to one-by-one.`)
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
      table: settingKey,
      scanned,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  })
}

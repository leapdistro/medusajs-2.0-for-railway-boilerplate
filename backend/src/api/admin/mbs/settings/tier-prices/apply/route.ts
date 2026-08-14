import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

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
 * Body: { scope: "flower" | "preroll" | "thcp_flower" | "flower_cbd" | "flower_cbg" }
 *   - "flower":       reads flower_tier_prices, scoped to category handles
 *                     matching its keys (classic / exotic / super / snow / rapper)
 *   - "preroll":      reads pre_roll_tier_prices, scoped to anything else
 *                     present in its key set (thc-a / hashholes / future
 *                     subcategories added in Medusa admin)
 *   - "thcp_flower":  reads thcp_flower_prices, scoped to the "thc-p"
 *                     category handle (single subcat, single 8pk variant).
 *                     Rides its own scope because THC-P flower's key set
 *                     ("thc-p") would collide with pre-roll variant sizes
 *                     if shared.
 *   - "flower_cbd":   reads flower_cbd_prices. Bare tier keys (classic /
 *                     exotic / …) match CBD variant metadata.tier_key
 *                     directly (Strategy 1). Strategy 2 category-handle
 *                     match strips the branch prefix ("cbd-classic" →
 *                     "classic") so variants without metadata still
 *                     resolve. Same shape for "flower_cbg".
 *   - "flower_cbg":   reads flower_cbg_prices; mirrors "flower_cbd".
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

  type Scope = "flower" | "preroll" | "thcp_flower" | "flower_cbd" | "flower_cbg"
  const body = (req.body ?? {}) as { scope?: Scope }
  const scope: Scope = body.scope ?? "flower"
  const VALID_SCOPES: Scope[] = ["flower", "preroll", "thcp_flower", "flower_cbd", "flower_cbg"]
  if (!VALID_SCOPES.includes(scope)) {
    res.status(400).json({ ok: false, message: `Invalid scope "${scope}" — must be one of ${VALID_SCOPES.join(", ")}` })
    return
  }

  const settingKey =
    scope === "flower" ? "flower_tier_prices"
    : scope === "preroll" ? "pre_roll_tier_prices"
    : scope === "thcp_flower" ? "thcp_flower_prices"
    : scope === "flower_cbd" ? "flower_cbd_prices"
    : "flower_cbg_prices"

  /* CBD/CBG variants live under prefixed category handles (cbd-classic,
   * cbg-exotic) but the price map keys off the bare tier suffix
   * (classic / exotic / …) to match receiving's tier_key metadata.
   * Strategy 2 handle match needs to strip the prefix before checking
   * validTierKeys membership. Non-CBD/CBG scopes pass through unchanged. */
  const handlePrefix =
    scope === "flower_cbd" ? "cbd-"
    : scope === "flower_cbg" ? "cbg-"
    : null
  const prices = (await settings.getSetting(settingKey)) as TierMap | null
  if (!prices) {
    res.status(400).json({
      ok: false,
      message: `${settingKey} not configured — save prices in MBS Settings first.`,
    })
    return
  }

  const validTierKeys = new Set(Object.keys(prices))

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

    /* Resolve tier + size via the strategy ladder. */
    let tier: string | null = null
    let size: string | null = null

    /* Strategy 1 — metadata. */
    if (typeof meta.tier_key === "string" && typeof meta.size_key === "string") {
      tier = meta.tier_key
      size = meta.size_key
    }

    /* Strategy 2 + 3 — category handle + SKU/title size. */
    if (!tier || !size) {
      const cats = (v.product?.categories ?? []) as Array<{ handle?: string | null }>
      /* When scope prefixes handles (CBD/CBG), strip the prefix before
       * membership check so "cbd-classic" resolves to bare "classic". */
      const stripPrefix = (h: string) =>
        handlePrefix && h.startsWith(handlePrefix) ? h.slice(handlePrefix.length) : h
      const matchedCat = cats.find((c) => {
        if (!c?.handle) return false
        const bare = stripPrefix(String(c.handle))
        return validTierKeys.has(bare)
      })
      if (matchedCat?.handle) {
        tier = stripPrefix(String(matchedCat.handle))
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

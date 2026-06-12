import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/distro-prices/apply { scope: "flower" | "preroll" }
 *
 * Bulk-propagates the Distro tier prices from mbs-settings to a Medusa
 * PriceList scoped to the `distro` customer group. Buyers in that group
 * see Distro prices natively at cart-resolution time; buyers NOT in the
 * group see the default tier prices (written by tier-prices/apply).
 *
 * Why a PriceList instead of writing the price row directly:
 *   - PriceLists support customer_group rules natively
 *   - One PriceList per pricing mode keeps the system legible in admin
 *   - Operator can deactivate (status: "draft") to disable distro
 *     pricing without losing the table
 *
 * Variant resolution mirrors the existing /tier-prices/apply endpoint:
 *   1. metadata.tier_key + metadata.size_key
 *   2. Category handle + SKU last segment
 *   3. Category handle + variant-title normalisation
 *
 * Idempotent — re-running adjusts existing PriceList prices and adds
 * missing ones; nothing is deleted.
 */

type TierMap = Record<string, Record<string, number>>

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
  return t
}

function sizeFromSku(sku: string | null | undefined): string | null {
  if (!sku) return null
  const parts = sku.toLowerCase().split("-").filter(Boolean)
  if (parts.length === 0) return null
  return parts[parts.length - 1]
}

const PRICE_LIST_TITLE = "Distro Pricing"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const pricingService: any = req.scope.resolve(Modules.PRICING)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const body = (req.body ?? {}) as { scope?: "flower" | "preroll" }
  const scope = body.scope ?? "flower"
  if (scope !== "flower" && scope !== "preroll") {
    res.status(400).json({ ok: false, message: `Invalid scope "${scope}" — must be "flower" or "preroll"` })
    return
  }

  const settingKey = scope === "flower" ? "flower_distro_prices" : "preroll_distro_prices"
  const prices = (await settings.getSetting(settingKey)) as TierMap | null
  if (!prices) {
    res.status(400).json({
      ok: false,
      message: `${settingKey} not configured — save prices in MBS Settings → ${scope === "flower" ? "Flower Distro Prices" : "Pre-Roll Distro Prices"} first.`,
    })
    return
  }

  /* Resolve the distro customer group — seed-customer-groups.ts
   * creates it. Tolerate missing with a clear error so the operator
   * knows to run the seed. */
  const groups = await customerService.listCustomerGroups({ name: ["distro"] }, { take: 1 })
  const distroGroup = groups?.[0]
  if (!distroGroup?.id) {
    res.status(400).json({
      ok: false,
      message: "`distro` customer group missing. Run `pnpm seed:customer-groups` on the backend.",
    })
    return
  }

  /* Find-or-create the PriceList. One PriceList shared by flower +
   * preroll distro prices — different variants, same audience. */
  const existingLists = await pricingService.listPriceLists(
    { title: [PRICE_LIST_TITLE] },
    { take: 1 },
  ).catch(() => [])
  let priceList = existingLists?.[0]
  if (!priceList?.id) {
    const [created] = await pricingService.createPriceLists([{
      title: PRICE_LIST_TITLE,
      description: "Distributor (B2B distro) selling prices. Scoped to the `distro` customer group.",
      type: "override",
      status: "active",
      rules: { "customer.group_id": [distroGroup.id] },
    }])
    priceList = created
    logger.info(`[distro-prices/apply] created price list ${priceList?.id}`)
  }
  if (!priceList?.id) {
    res.status(500).json({ ok: false, message: "Could not create or load distro PriceList" })
    return
  }

  const validTierKeys = new Set(Object.keys(prices))

  /* Pull every variant + its price_set id. We need price_set.id (not
   * price_set.prices.id) — PriceList prices target the SET, not an
   * existing row. We also need a peek at existing list prices to
   * decide add-vs-update. */
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "sku", "metadata",
      "options.option.title", "options.value",
      "product.categories.id", "product.categories.handle",
      "price_set.id",
    ],
    filters: { deleted_at: null },
  })

  /* Existing list prices, keyed by price_set_id. Used to decide
   * update-existing vs add-new. */
  const existingListPrices = await pricingService.listPrices(
    { price_list_id: [priceList.id] },
    { take: 100000 },
  ).catch(() => [])
  const byPriceSet: Record<string, any> = {}
  for (const p of existingListPrices ?? []) {
    if (p?.price_set_id) byPriceSet[String(p.price_set_id)] = p
  }

  const toAdd: Array<{ price_set_id: string; currency_code: string; amount: number }> = []
  const toUpdate: Array<{ id: string; amount: number }> = []
  let scanned = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    scanned += 1
    const meta = (v.metadata ?? {}) as Record<string, any>

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
      const matchedCat = cats.find((c) => c?.handle && validTierKeys.has(String(c.handle)))
      if (matchedCat?.handle) {
        tier = String(matchedCat.handle)
        const validSizes = new Set(Object.keys(prices[tier] ?? {}))
        const skuSize = sizeFromSku(v.sku)
        if (skuSize && validSizes.has(skuSize)) {
          size = skuSize
        } else {
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

    const priceSetId = v.price_set?.id
    if (!priceSetId) { bumpSkip("no_price_set"); continue }

    const existing = byPriceSet[String(priceSetId)]
    if (existing?.id) {
      if (Number(existing.amount) === newPrice) {
        bumpSkip("already_current"); continue
      }
      toUpdate.push({ id: String(existing.id), amount: newPrice })
    } else {
      toAdd.push({ price_set_id: String(priceSetId), currency_code: "usd", amount: newPrice })
    }
  }

  let added = 0
  let updated = 0

  if (toAdd.length > 0) {
    try {
      await pricingService.addPriceListPrices([{ price_list_id: priceList.id, prices: toAdd }])
      added = toAdd.length
    } catch (e: any) {
      logger.warn(`[distro-prices/apply] batch add failed: ${e?.message}. Falling back to one-by-one.`)
      for (const p of toAdd) {
        try {
          await pricingService.addPriceListPrices([{ price_list_id: priceList.id, prices: [p] }])
          added += 1
        } catch (e2: any) {
          logger.warn(`[distro-prices/apply] add for ${p.price_set_id} failed: ${e2?.message}`)
          bumpSkip("add_failed")
        }
      }
    }
  }

  if (toUpdate.length > 0) {
    try {
      await pricingService.updatePriceListPrices([{
        id: priceList.id,
        prices: toUpdate.map((u) => ({ id: u.id, amount: u.amount })),
      }])
      updated = toUpdate.length
    } catch (e: any) {
      logger.warn(`[distro-prices/apply] batch update failed: ${e?.message}. Falling back to one-by-one.`)
      for (const u of toUpdate) {
        try {
          await pricingService.updatePriceListPrices([{
            id: priceList.id,
            prices: [{ id: u.id, amount: u.amount }],
          }])
          updated += 1
        } catch (e2: any) {
          logger.warn(`[distro-prices/apply] update ${u.id} failed: ${e2?.message}`)
          bumpSkip("update_failed")
        }
      }
    }
  }

  res.json({
    ok: true,
    summary: {
      scope,
      price_list_id: priceList.id,
      scanned,
      added,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  })
}

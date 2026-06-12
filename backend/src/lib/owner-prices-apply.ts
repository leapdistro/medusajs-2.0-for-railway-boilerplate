import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"

/**
 * Owner Stores pricing — shared apply logic.
 *
 * Walks every variant in scope, reads landed cost from inventory_item
 * metadata, computes `(landed_cost + markup) × pool_units`, and
 * upserts each price into the customer-group-scoped "Owner Stores
 * Pricing" PriceList.
 *
 * Called by:
 *   - POST /admin/mbs/settings/owner-prices/apply (operator click — no
 *     variant filter, walks the catalog)
 *   - subscribers/receiving-to-owner-prices (receiving.saved event —
 *     could pass variantIds to scope, currently walks the catalog too
 *     since the cost write affects every variant linked to the
 *     inventory_item and the work is cheap)
 */

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

/* Pool-unit multiplier per size — how many pool units (QPs for flower,
 * boxes for pre-roll) a single variant represents. Mirrors the
 * receiving system's SIZE_QP_MULTIPLIER / inputToPoolMultiplier. */
const SIZE_POOL_UNITS: Record<"flower" | "preroll", Record<string, number>> = {
  flower:  { qp: 1, half: 2, lb: 4 },
  preroll: { "30pk": 1, "15pk": 1 },
}

const PRICE_LIST_TITLE = "Owner Stores Pricing"
const FLOWER_TIER_KEYS = new Set(["classic", "exotic", "super", "snow", "rapper"])

export type OwnerApplyResult = {
  ok: boolean
  scope: "flower" | "preroll"
  price_list_id?: string
  markup?: number
  scanned: number
  added: number
  updated: number
  skipped: number
  skip_reasons: Record<string, number>
  error?: string
}

export async function applyOwnerPrices(
  containerOrScope: any,
  scope: "flower" | "preroll",
): Promise<OwnerApplyResult> {
  const scopeContainer = containerOrScope
  const logger = scopeContainer.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = scopeContainer.resolve(MBS_SETTINGS_MODULE)
  const pricingService: any = scopeContainer.resolve(Modules.PRICING)
  const customerService: any = scopeContainer.resolve(Modules.CUSTOMER)
  const query = scopeContainer.resolve(ContainerRegistrationKeys.QUERY)

  const markupKey = scope === "flower" ? "flower_owner_markup_per_qp" : "preroll_owner_markup_per_box"
  const markupRaw = await settings.getSetting(markupKey)
  const markup = typeof markupRaw === "number" ? markupRaw : Number(markupRaw)
  if (!Number.isFinite(markup) || markup < 0) {
    return {
      ok: false, scope, scanned: 0, added: 0, updated: 0, skipped: 0,
      skip_reasons: {},
      error: `${markupKey} not configured (must be a non-negative number)`,
    }
  }

  const groups = await customerService.listCustomerGroups({ name: ["owner_stores"] }, { take: 1 })
  const ownerGroup = groups?.[0]
  if (!ownerGroup?.id) {
    return {
      ok: false, scope, scanned: 0, added: 0, updated: 0, skipped: 0,
      skip_reasons: {},
      error: "`owner_stores` customer group missing (run seed:customer-groups)",
    }
  }

  /* Find-or-create PriceList. Rule key is `customer.groups.id` (plural,
   * dotted) per Medusa 2.13. */
  const RULES = { "customer.groups.id": [ownerGroup.id] }
  const existingLists = await pricingService.listPriceLists(
    { title: [PRICE_LIST_TITLE] },
    { take: 1 },
  ).catch(() => [])
  let priceList = existingLists?.[0]
  if (!priceList?.id) {
    const [created] = await pricingService.createPriceLists([{
      title: PRICE_LIST_TITLE,
      description: "Operator's own retail stores — landed cost + admin-set markup. Scoped to the `owner_stores` customer group.",
      type: "override",
      status: "active",
      rules: RULES,
    }])
    priceList = created
    logger.info(`[owner-prices] created price list ${priceList?.id}`)
  } else {
    try {
      await pricingService.updatePriceLists([{ id: priceList.id, rules: RULES, status: "active" }])
    } catch (e: any) {
      logger.warn(`[owner-prices] could not refresh rules: ${e?.message}`)
    }
  }
  if (!priceList?.id) {
    return {
      ok: false, scope, scanned: 0, added: 0, updated: 0, skipped: 0,
      skip_reasons: {},
      error: "Could not create or load Owner Stores PriceList",
    }
  }

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "sku", "metadata",
      "options.option.title", "options.value",
      "product.categories.id", "product.categories.handle",
      "price_set.id",
      "inventory_items.inventory.metadata",
    ],
    filters: { deleted_at: null },
  })

  const { data: priceListExpanded } = await query.graph({
    entity: "price_list",
    fields: ["id", "prices.id", "prices.amount", "prices.price_set_id"],
    filters: { id: priceList.id },
  })
  const byPriceSet: Record<string, { id: string }> = {}
  for (const pl of (priceListExpanded as any[]) ?? []) {
    for (const p of (pl.prices ?? []) as any[]) {
      if (p?.price_set_id && p?.id) {
        byPriceSet[String(p.price_set_id)] = { id: String(p.id) }
      }
    }
  }

  const sizeMultipliers = SIZE_POOL_UNITS[scope]
  const validSizesSet = new Set(Object.keys(sizeMultipliers))

  const toAdd: Array<{ price_set_id: string; currency_code: string; amount: number }> = []
  const toUpdate: Array<{ id: string; amount: number }> = []
  let scanned = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    scanned += 1
    const meta = (v.metadata ?? {}) as Record<string, any>

    let size: string | null = null
    let inScope = false

    const cats = (v.product?.categories ?? []) as Array<{ handle?: string | null }>
    if (typeof meta.size_key === "string") size = meta.size_key
    if (scope === "flower") {
      inScope = cats.some((c) => c?.handle && FLOWER_TIER_KEYS.has(String(c.handle)))
    } else {
      const matchedSize = size && validSizesSet.has(size)
      const skuSize = sizeFromSku(v.sku)
      const sizeOpt = ((v.options ?? []) as any[])
        .find((o) => String(o?.option?.title ?? "").toLowerCase() === "size")
      const candidate = sizeOpt?.value ?? v.title
      const normalized = normalizeSizeFromTitle(candidate)
      inScope = Boolean(
        matchedSize ||
        (skuSize && validSizesSet.has(skuSize)) ||
        (normalized && validSizesSet.has(normalized))
      )
    }
    if (!inScope) { bumpSkip("out_of_scope"); continue }

    if (!size || !validSizesSet.has(size)) {
      const skuSize = sizeFromSku(v.sku)
      if (skuSize && validSizesSet.has(skuSize)) {
        size = skuSize
      } else {
        const sizeOpt = ((v.options ?? []) as any[])
          .find((o) => String(o?.option?.title ?? "").toLowerCase() === "size")
        const candidate = sizeOpt?.value ?? v.title
        const normalized = normalizeSizeFromTitle(candidate)
        if (normalized && validSizesSet.has(normalized)) size = normalized
      }
    }

    if (!size || !validSizesSet.has(size)) { bumpSkip("unresolved_size"); continue }

    const poolUnits = sizeMultipliers[size]
    if (!poolUnits || poolUnits <= 0) { bumpSkip("no_pool_multiplier"); continue }

    const invItems = (v.inventory_items ?? []) as Array<{ inventory?: { metadata?: any } | null }>
    const invMeta = invItems[0]?.inventory?.metadata ?? null
    const landedRaw = invMeta?.landed_per_qp
    const landedPerUnit = typeof landedRaw === "number" ? landedRaw : Number(landedRaw)
    if (!Number.isFinite(landedPerUnit) || landedPerUnit <= 0) {
      bumpSkip("no_landed_cost"); continue
    }

    const newPrice = (landedPerUnit + markup) * poolUnits
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      bumpSkip("computed_price_invalid"); continue
    }

    const priceSetId = v.price_set?.id
    if (!priceSetId) { bumpSkip("no_price_set"); continue }

    const existing = byPriceSet[String(priceSetId)]
    if (existing?.id) {
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
      logger.warn(`[owner-prices] batch add failed: ${e?.message}. Falling back to one-by-one.`)
      for (const p of toAdd) {
        try {
          await pricingService.addPriceListPrices([{ price_list_id: priceList.id, prices: [p] }])
          added += 1
        } catch (e2: any) {
          logger.warn(`[owner-prices] add for ${p.price_set_id} failed: ${e2?.message}`)
          bumpSkip("add_failed")
        }
      }
    }
  }

  if (toUpdate.length > 0) {
    try {
      await pricingService.updatePriceListPrices([{
        price_list_id: priceList.id,
        prices: toUpdate.map((u) => ({ id: u.id, amount: u.amount })),
      }])
      updated = toUpdate.length
    } catch (e: any) {
      logger.warn(`[owner-prices] batch update failed: ${e?.message}. Falling back to one-by-one.`)
      for (const u of toUpdate) {
        try {
          await pricingService.updatePriceListPrices([{
            id: priceList.id,
            prices: [{ id: u.id, amount: u.amount }],
          }])
          updated += 1
        } catch (e2: any) {
          logger.warn(`[owner-prices] update ${u.id} failed: ${e2?.message}`)
          bumpSkip("update_failed")
        }
      }
    }
  }

  return {
    ok: true,
    scope,
    price_list_id: priceList.id,
    markup,
    scanned,
    added,
    updated,
    skipped,
    skip_reasons: skipReasons,
  }
}

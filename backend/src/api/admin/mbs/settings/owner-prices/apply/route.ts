import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/owner-prices/apply { scope: "flower" | "preroll" }
 *
 * Owner Stores pricing = (landed_cost_per_pool_unit + markup) × pool_units
 * per variant, written to a Medusa PriceList scoped to the `owner_stores`
 * customer group. Mirrors the distro-prices/apply pattern but computes
 * the price dynamically from each variant's inventory cost instead of
 * looking it up in a static table.
 *
 * Pool-unit semantics:
 *   - Flower: pool unit = QP. A Half variant pulls 2 QPs, an LB pulls 4.
 *     landed_per_qp lives on inventory_item.metadata (set by receiving).
 *     markup_per_qp lives on settings.flower_owner_markup_per_qp.
 *     price = (landed_per_qp + markup_per_qp) × pool_units_for_size
 *   - Pre-Roll: pool unit = box. inputToPoolMultiplier=1 so a variant IS
 *     one box. landed_per_qp on the inventory_item is actually landed_per_box.
 *     markup_per_box lives on settings.preroll_owner_markup_per_box.
 *     price = landed_per_box + markup_per_box
 *
 * Variant resolution mirrors distro-prices/apply (metadata → category+SKU
 * → category+title). Variants without landed cost (manually-created, no
 * receiving) get skipped with reason `no_landed_cost`.
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

/* Valid tier keys for resolution — flower tiers come from the catalog
 * structure (classic/exotic/super/snow/rapper), preroll uses subcategory
 * handles. We list flower tiers explicitly; preroll matches any category
 * handle, since the subcategory list grows dynamically. */
const FLOWER_TIER_KEYS = new Set(["classic", "exotic", "super", "snow", "rapper"])

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

  const markupKey = scope === "flower" ? "flower_owner_markup_per_qp" : "preroll_owner_markup_per_box"
  const markupRaw = await settings.getSetting(markupKey)
  const markup = typeof markupRaw === "number" ? markupRaw : Number(markupRaw)
  if (!Number.isFinite(markup) || markup < 0) {
    res.status(400).json({
      ok: false,
      message: `${markupKey} not configured (must be a non-negative number). Save in MBS Settings → Owner Markup first.`,
    })
    return
  }

  /* Resolve the owner_stores customer group — seeded by
   * seed-customer-groups.ts. */
  const groups = await customerService.listCustomerGroups({ name: ["owner_stores"] }, { take: 1 })
  const ownerGroup = groups?.[0]
  if (!ownerGroup?.id) {
    res.status(400).json({
      ok: false,
      message: "`owner_stores` customer group missing. Run `pnpm seed:customer-groups` on the backend.",
    })
    return
  }

  /* Find-or-create the PriceList. Rule key: customer.groups.id (plural,
   * dotted) per Medusa 2.13 — see slice 4 fix. */
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
    logger.info(`[owner-prices/apply] created price list ${priceList?.id}`)
  } else {
    /* Idempotent rules refresh — protects against the slice-4-class
     * "wrong rule attribute" regression. */
    try {
      await pricingService.updatePriceLists([{ id: priceList.id, rules: RULES, status: "active" }])
    } catch (e: any) {
      logger.warn(`[owner-prices/apply] could not refresh rules: ${e?.message}`)
    }
  }
  if (!priceList?.id) {
    res.status(500).json({ ok: false, message: "Could not create or load Owner Stores PriceList" })
    return
  }

  /* Pull every variant + price_set id + inventory cost. Same shape as
   * distro-prices/apply plus the inventory_items.metadata join so we
   * can read landed_per_qp per variant. */
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

  /* Existing list prices by price_set_id (query.graph workaround for
   * the same listPrices-returns-empty bug we hit in slice 4). */
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
  logger.info(`[owner-prices/apply] price-list ${priceList.id} has ${Object.keys(byPriceSet).length} existing prices`)

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

    /* Strategy 1 — metadata.size_key. For scope check, also look at
     * categories: if a flower variant has a recognized flower tier
     * category, it's in scope. */
    const cats = (v.product?.categories ?? []) as Array<{ handle?: string | null }>
    if (typeof meta.size_key === "string") size = meta.size_key
    if (scope === "flower") {
      inScope = cats.some((c) => c?.handle && FLOWER_TIER_KEYS.has(String(c.handle)))
    } else {
      /* preroll — match any size key in the preroll multiplier map.
       * That's a tight enough filter (size keys are namespaced). */
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

    /* Strategy 2 + 3 — derive size from SKU / title when metadata
     * didn't have it. */
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

    /* Landed cost — `landed_per_qp` on the inventory_item.metadata,
     * set by receiving-save. For pool products (flower QP/Half/LB
     * sharing one inventory_item) the same value covers all three
     * variants; receiving updates it on each restock with the latest
     * weighted shipping spread. */
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
      logger.warn(`[owner-prices/apply] batch add failed: ${e?.message}. Falling back to one-by-one.`)
      for (const p of toAdd) {
        try {
          await pricingService.addPriceListPrices([{ price_list_id: priceList.id, prices: [p] }])
          added += 1
        } catch (e2: any) {
          logger.warn(`[owner-prices/apply] add for ${p.price_set_id} failed: ${e2?.message}`)
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
      logger.warn(`[owner-prices/apply] batch update failed: ${e?.message}. Falling back to one-by-one.`)
      for (const u of toUpdate) {
        try {
          await pricingService.updatePriceListPrices([{
            id: priceList.id,
            prices: [{ id: u.id, amount: u.amount }],
          }])
          updated += 1
        } catch (e2: any) {
          logger.warn(`[owner-prices/apply] update ${u.id} failed: ${e2?.message}`)
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
      markup,
      scanned,
      added,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  })
}

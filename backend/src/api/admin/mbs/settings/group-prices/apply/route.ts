import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/group-prices/apply
 *   { scope: "flower" | "preroll", group: "distro" | "tier_2" | "tier_3" }
 *
 * Bulk-propagates a customer-group-scoped price table from mbs-settings
 * to a Medusa PriceList scoped to that customer group. Buyers in the
 * group see this price natively at cart-resolution time; buyers NOT in
 * the group fall through to the default tier price (written by
 * tier-prices/apply).
 *
 * One route shared by Distro / Tier 2 / Tier 3 — same machinery, just
 * different group + settings key + PriceList title per call.
 *
 * Why a PriceList instead of writing the price row directly:
 *   - PriceLists support customer_group rules natively
 *   - One PriceList per pricing mode keeps the system legible in admin
 *   - Operator can deactivate (status: "draft") to disable a mode
 *     without losing the table
 *
 * Variant resolution mirrors /tier-prices/apply:
 *   1. metadata.tier_key + metadata.size_key
 *   2. Category handle + SKU last segment
 *   3. Category handle + variant-title normalisation
 *
 * Idempotent — re-running adjusts existing PriceList prices and adds
 * missing ones; nothing is deleted.
 */

type TierMap = Record<string, Record<string, number>>

type GroupKey = "distro" | "tier_2" | "tier_3"
type Scope = "flower" | "preroll" | "thcp_flower"

/* Group config — one row per supported customer-group pricing mode.
 * Settings keys are derived: <scope>_<key>_prices for tier_2/tier_3 and
 * flower_distro_prices / preroll_distro_prices for distro (keeps the
 * legacy key names so historical data doesn't need a migration).
 * THC-P Flower only supports distro today; tier_2/tier_3 keys are
 * placeholders that read undefined and return a clear operator error. */
const GROUPS: Record<GroupKey, {
  groupName: string
  priceListTitle: string
  description: string
  flowerSettingKey: string
  prerollSettingKey: string
  thcpFlowerSettingKey: string
}> = {
  distro: {
    groupName: "distro",
    priceListTitle: "Distro Pricing",
    description: "Distributor (B2B distro) selling prices. Scoped to the `distro` customer group.",
    flowerSettingKey: "flower_distro_prices",
    prerollSettingKey: "preroll_distro_prices",
    thcpFlowerSettingKey: "thcp_flower_distro_prices",
  },
  tier_2: {
    groupName: "tier_2",
    priceListTitle: "Tier 2 Pricing",
    description: "Tier 2 wholesale selling prices. Scoped to the `tier_2` customer group.",
    flowerSettingKey: "flower_tier_2_prices",
    prerollSettingKey: "preroll_tier_2_prices",
    /* Not seeded — request returns "not configured" until an operator
     * enables tier_2 pricing for THC-P Flower. */
    thcpFlowerSettingKey: "thcp_flower_tier_2_prices",
  },
  tier_3: {
    groupName: "tier_3",
    priceListTitle: "Tier 3 Pricing",
    description: "Tier 3 wholesale selling prices. Scoped to the `tier_3` customer group.",
    flowerSettingKey: "flower_tier_3_prices",
    prerollSettingKey: "preroll_tier_3_prices",
    thcpFlowerSettingKey: "thcp_flower_tier_3_prices",
  },
}

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

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const pricingService: any = req.scope.resolve(Modules.PRICING)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const body = (req.body ?? {}) as { scope?: Scope; group?: GroupKey }
  const scope = body.scope ?? "flower"
  const group = body.group ?? "distro"
  if (scope !== "flower" && scope !== "preroll" && scope !== "thcp_flower") {
    res.status(400).json({ ok: false, message: `Invalid scope "${scope}" — must be "flower", "preroll", or "thcp_flower"` })
    return
  }
  const cfg = GROUPS[group]
  if (!cfg) {
    res.status(400).json({ ok: false, message: `Invalid group "${group}" — must be one of ${Object.keys(GROUPS).join(", ")}` })
    return
  }

  const settingKey =
    scope === "flower" ? cfg.flowerSettingKey
    : scope === "preroll" ? cfg.prerollSettingKey
    : cfg.thcpFlowerSettingKey
  const prices = (await settings.getSetting(settingKey)) as TierMap | null
  if (!prices) {
    res.status(400).json({
      ok: false,
      message: `${settingKey} not configured — save prices in MBS Settings first.`,
    })
    return
  }

  /* Resolve the target customer group. seed-customer-groups.ts creates
   * them; tolerate missing with a clear error so the operator knows to
   * run the seed. */
  const groups = await customerService.listCustomerGroups({ name: [cfg.groupName] }, { take: 1 })
  const targetGroup = groups?.[0]
  if (!targetGroup?.id) {
    res.status(400).json({
      ok: false,
      message: `\`${cfg.groupName}\` customer group missing. Run \`pnpm seed:customer-groups\` on the backend.`,
    })
    return
  }

  /* Find-or-create the PriceList. Customer-group rule attribute MUST be
   * `customer.groups.id` (plural, dotted) — see pricing migration
   * Migration20241212190401 for the legacy `customer_group_id` form. */
  const RULES = { "customer.groups.id": [targetGroup.id] }
  const existingLists = await pricingService.listPriceLists(
    { title: [cfg.priceListTitle] },
    { take: 1 },
  ).catch(() => [])
  let priceList = existingLists?.[0]
  if (!priceList?.id) {
    const [created] = await pricingService.createPriceLists([{
      title: cfg.priceListTitle,
      description: cfg.description,
      type: "override",
      status: "active",
      rules: RULES,
    }])
    priceList = created
    logger.info(`[group-prices/apply:${group}] created price list ${priceList?.id}`)
  } else {
    /* Repair pass — overwrite rules to canonical shape; idempotent. */
    try {
      await pricingService.updatePriceLists([{ id: priceList.id, rules: RULES, status: "active" }])
      logger.info(`[group-prices/apply:${group}] refreshed rules on price list ${priceList.id}`)
    } catch (e: any) {
      logger.warn(`[group-prices/apply:${group}] could not refresh rules: ${e?.message}`)
    }
  }
  if (!priceList?.id) {
    res.status(500).json({ ok: false, message: `Could not create or load ${cfg.priceListTitle} PriceList` })
    return
  }

  const validTierKeys = new Set(Object.keys(prices))

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

  /* Existing list prices, keyed by price_set_id — used to decide
   * add-vs-update. Fetched via query.graph (more reliable than
   * pricingService.listPrices, which silently returned [] in 2.13). */
  const { data: priceListExpanded } = await query.graph({
    entity: "price_list",
    fields: ["id", "prices.id", "prices.amount", "prices.price_set_id"],
    filters: { id: priceList.id },
  })
  const byPriceSet: Record<string, { id: string; amount: number | string }> = {}
  for (const pl of (priceListExpanded as any[]) ?? []) {
    for (const p of (pl.prices ?? []) as any[]) {
      if (p?.price_set_id && p?.id) {
        byPriceSet[String(p.price_set_id)] = { id: String(p.id), amount: p.amount }
      }
    }
  }
  logger.info(`[group-prices/apply:${group}] price-list ${priceList.id} has ${Object.keys(byPriceSet).length} existing prices`)

  const toAdd: Array<{ price_set_id: string; currency_code: string; amount: number }> = []
  const toUpdate: Array<{ id: string; price_set_id: string; currency_code: string; amount: number }> = []
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
      toUpdate.push({
        id: String(existing.id),
        price_set_id: String(priceSetId),
        currency_code: "usd",
        amount: newPrice,
      })
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
      logger.warn(`[group-prices/apply:${group}] batch add failed: ${e?.message}. Falling back to one-by-one.`)
      for (const p of toAdd) {
        try {
          await pricingService.addPriceListPrices([{ price_list_id: priceList.id, prices: [p] }])
          added += 1
        } catch (e2: any) {
          logger.warn(`[group-prices/apply:${group}] add for ${p.price_set_id} failed: ${e2?.message}`)
          bumpSkip("add_failed")
        }
      }
    }
  }

  if (toUpdate.length > 0) {
    try {
      await pricingService.updatePriceListPrices([{
        price_list_id: priceList.id,
        prices: toUpdate.map((u) => ({
          id: u.id,
          price_set_id: u.price_set_id,
          currency_code: u.currency_code,
          amount: u.amount,
        })),
      }])
      updated = toUpdate.length
    } catch (e: any) {
      logger.warn(`[group-prices/apply:${group}] batch update failed: ${e?.message}. Falling back to one-by-one.`)
      for (const u of toUpdate) {
        try {
          await pricingService.updatePriceListPrices([{
            price_list_id: priceList.id,
            prices: [{
              id: u.id,
              price_set_id: u.price_set_id,
              currency_code: u.currency_code,
              amount: u.amount,
            }],
          }])
          updated += 1
        } catch (e2: any) {
          logger.warn(`[group-prices/apply:${group}] update ${u.id} failed: ${e2?.message}`)
          bumpSkip("update_failed")
        }
      }
    }
  }

  /* Verify the writes persisted — see commit 737eaaa for the silent
   * no-op bug we're guarding against. Re-read a sample of touched
   * prices and assert amount matches expected. */
  const sample = [...toUpdate, ...toAdd].slice(0, 3)
  if (sample.length > 0) {
    const { data: re } = await query.graph({
      entity: "price_list",
      fields: ["id", "prices.id", "prices.amount", "prices.price_set_id"],
      filters: { id: priceList.id },
    })
    const fresh: Record<string, number> = {}
    for (const pl of (re as any[]) ?? []) {
      for (const p of (pl.prices ?? []) as any[]) {
        const amt = Number((p?.amount as any)?.value ?? (p?.amount as any)?.numeric ?? p?.amount)
        if (p?.price_set_id && Number.isFinite(amt)) fresh[String(p.price_set_id)] = amt
      }
    }
    const mismatches: Array<{ price_set_id: string; expected: number; actual: number | null }> = []
    for (const u of sample) {
      const actual = fresh[u.price_set_id] ?? null
      if (actual == null || Math.abs(actual - u.amount) > 0.01) {
        mismatches.push({ price_set_id: u.price_set_id, expected: u.amount, actual })
      }
    }
    if (mismatches.length > 0) {
      const first = mismatches[0]
      const msg = `Apply reported success but writes did not persist (sample mismatch ${mismatches.length}/${sample.length}). Example: price_set ${first.price_set_id} expected $${first.expected.toFixed(2)} actual $${first.actual?.toFixed(2) ?? "null"}.`
      logger.error(`[group-prices/apply:${group}] ${msg}`)
      res.status(500).json({
        ok: false,
        message: msg,
        summary: {
          scope,
          group,
          price_list_id: priceList.id,
          scanned,
          added: 0,
          updated: 0,
          skipped: scanned,
          skip_reasons: { ...skipReasons, write_did_not_persist: mismatches.length },
        },
      })
      return
    }
  }

  res.json({
    ok: true,
    summary: {
      scope,
      group,
      price_list_id: priceList.id,
      scanned,
      added,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  })
}

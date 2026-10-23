import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import { scopedCategoryOf, scopeForTable } from "./price-scope"
import { GROUP_LEVEL_CONFIG, type GroupLevel } from "./price-levels"

/**
 * Shared implementation of "apply customer-group prices" used by both
 * the HTTP endpoint (POST /admin/mbs/settings/group-prices/apply) and
 * the receiving.saved subscriber (auto-propagates new/restocked
 * strains onto every configured mode PriceList).
 *
 * Reads the given mbs-settings table at a group level, finds-or-
 * creates a Medusa PriceList scoped to that customer group, then
 * writes / updates PriceListPrice rows for every variant we can
 * confidently resolve to a (tier, size) pair.
 *
 * Variant resolution ladder (mirrors tier-prices/apply):
 *   1. metadata.tier_key + metadata.size_key — receiving-stamped
 *   2. the product's sub-category key (from its category profile) + SKU
 *      last segment
 *   3. same as #2 but with a variant-title → size_key mapping
 *
 * The table's products are those of every profile naming it at this
 * level (lib/price-levels.ts): CBD and CBG flower share the flower
 * tables, so one apply covers all three.
 *
 * Extracted from api/admin/mbs/settings/group-prices/apply/route.ts
 * (2026-07) so the receiving subscriber can call the same code path
 * — was previously operator-only via the admin Save button.
 */

export type GroupKey = GroupLevel

export type PlannedPrice = {
  variant_id: string
  price_set_id: string
  amount: number
  /** Amount already in the PriceList, or null when none. */
  current: number | null
}

export type ApplyGroupPricesResult = {
  ok: boolean
  error?: string
  summary?: {
    table: string
    group: GroupKey
    price_list_id: string | null
    scanned: number
    added: number
    updated: number
    skipped: number
    skip_reasons: Record<string, number>
  }
  /** Dry run only: every price the apply would write. */
  planned?: PlannedPrice[]
}

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

export async function applyGroupPrices(
  container: any,
  table: string,
  group: GroupKey,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyGroupPricesResult> {
  const dryRun = !!opts.dryRun
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const pricingService: any = container.resolve(Modules.PRICING)
  const customerService: any = container.resolve(Modules.CUSTOMER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const cfg = GROUP_LEVEL_CONFIG[group]
  if (!cfg) return { ok: false, error: `Invalid group "${group}"` }

  const prices = (await settings.getSetting(table)) as TierMap | null
  if (!prices) {
    return { ok: false, error: `${table} not configured — save prices in MBS Settings first.` }
  }

  const groups = await customerService.listCustomerGroups({ name: [cfg.groupName] }, { take: 1 })
  const targetGroup = groups?.[0]
  if (!targetGroup?.id) {
    return {
      ok: false,
      error: `\`${cfg.groupName}\` customer group missing. Run \`pnpm seed:customer-groups\` on the backend.`,
    }
  }

  const RULES = { "customer.groups.id": [targetGroup.id] }
  const existingLists = await pricingService.listPriceLists(
    { title: [cfg.priceListTitle] },
    { take: 1 },
  ).catch(() => [])
  let priceList = existingLists?.[0]
  if (dryRun) {
    /* No PriceList yet means every price would be an add. */
  } else if (!priceList?.id) {
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
    try {
      await pricingService.updatePriceLists([{ id: priceList.id, rules: RULES, status: "active" }])
    } catch (e: any) {
      logger.warn(`[group-prices/apply:${group}] could not refresh rules: ${e?.message}`)
    }
  }
  if (!priceList?.id && !dryRun) {
    return { ok: false, error: `Could not create or load ${cfg.priceListTitle} PriceList` }
  }

  const validTierKeys = new Set(Object.keys(prices))
  /* Only products under this table's receiving profiles — see
   * lib/price-scope.ts for why tier keys alone aren't enough. */
  const scope = await scopeForTable(container, query, group, table)

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

  const { data: priceListExpanded } = priceList?.id
    ? await query.graph({
        entity: "price_list",
        fields: ["id", "prices.id", "prices.amount", "prices.price_set_id"],
        filters: { id: priceList.id },
      })
    : { data: [] }
  const byPriceSet: Record<string, { id: string; amount: number | string }> = {}
  for (const pl of (priceListExpanded as any[]) ?? []) {
    for (const p of (pl.prices ?? []) as any[]) {
      if (p?.price_set_id && p?.id) {
        byPriceSet[String(p.price_set_id)] = { id: String(p.id), amount: p.amount }
      }
    }
  }

  const planned: PlannedPrice[] = []
  const toAdd: Array<{ price_set_id: string; currency_code: string; amount: number }> = []
  const toUpdate: Array<{ id: string; price_set_id: string; currency_code: string; amount: number }> = []
  let scanned = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    scanned += 1
    const scoped = scopedCategoryOf(v.product, scope.categories)
    if (!scoped) { bumpSkip("out_of_scope_category"); continue }
    const meta = (v.metadata ?? {}) as Record<string, any>

    let tier: string | null = null
    let size: string | null = null

    if (typeof meta.tier_key === "string" && typeof meta.size_key === "string") {
      tier = meta.tier_key
      size = meta.size_key
    }

    if (!tier || !size) {
      /* The sub-category key, not the handle: CBD tier handles are
       * cbd-classic etc. while the table is keyed by bare tier. */
      if (validTierKeys.has(scoped.subcategory.key)) {
        tier = scoped.subcategory.key
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
    planned.push({
      variant_id: String(v.id),
      price_set_id: String(priceSetId),
      amount: newPrice,
      current: existing ? amountOf(existing.amount) : null,
    })
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

  if (dryRun) {
    return {
      ok: true,
      summary: {
        table, group, price_list_id: priceList?.id ?? null, scanned,
        added: toAdd.length, updated: toUpdate.length, skipped, skip_reasons: skipReasons,
      },
      planned,
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

  /* Verify a sample of writes persisted — same guardrail as the HTTP
   * route (commit 737eaaa's silent no-op bug). */
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
        const amt = amountOf(p?.amount)
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
      return {
        ok: false,
        error: msg,
        summary: {
          table,
          group,
          price_list_id: priceList.id,
          scanned,
          added: 0,
          updated: 0,
          skipped: scanned,
          skip_reasons: { ...skipReasons, write_did_not_persist: mismatches.length },
        },
      }
    }
  }

  return {
    ok: true,
    summary: {
      table,
      group,
      price_list_id: priceList.id,
      scanned,
      added,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  }
}

/** BigNumber-safe amount (Number(BigNumber) is NaN). */
function amountOf(a: any): number {
  return Number(a?.value ?? a?.numeric ?? a)
}

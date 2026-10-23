import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import type { ReceivingProfile } from "./receiving-profiles"
import { loadProfiles } from "./profile-store"
import { categoriesForProfiles, scopedCategoryOf } from "./price-scope"

/**
 * Per-variant shipping cost (zero-code categories, Phase 3).
 *
 * `shipping_rates` holds one bucket per category profile
 * (profile.shippingRatesKey; profiles naming the same bucket share it).
 * A bucket is either flat — { qp: 20, half: 35, lb: 50 }, one rate per
 * size for every sub-category — or per sub-category —
 * { cbd: { "30pk": 4 }, hashholes: { "15pk": 4 } }.
 *
 * The rate is stamped on variant.weight as cents (the only variant field
 * the fulfillment provider sees at quote time) with a dollars mirror in
 * metadata.shipping_rate_usd. Receiving stamps new variants; the
 * Shipping Rates tab re-stamps existing ones (applyShippingRates).
 */

export type ShippingBucket = Record<string, number | Record<string, number>>
export type ShippingRates = Record<string, ShippingBucket>

const positive = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null

/** True when every value in the bucket is a number (one rate per size). */
export function isFlatBucket(bucket: ShippingBucket | null | undefined): boolean {
  const values = Object.values(bucket ?? {})
  return values.length > 0 && values.every((v) => typeof v === "number")
}

/** Dollars for (bucket, sub-category, size), or null when none is set. */
export function rateFor(
  rates: ShippingRates | null | undefined,
  bucketKey: string | null | undefined,
  subKey: string,
  sizeKey: string,
): number | null {
  if (!rates || !bucketKey) return null
  const bucket = rates[bucketKey]
  if (!bucket) return null
  const nested = bucket[subKey]
  if (nested && typeof nested === "object") return positive(nested[sizeKey])
  return positive(bucket[sizeKey])
}

/** The rate for a variant a profile receives. */
export function rateForProfile(
  rates: ShippingRates | null | undefined,
  profile: ReceivingProfile,
  subKey: string,
  sizeKey: string,
): number | null {
  return rateFor(rates, profile.shippingRatesKey, subKey, sizeKey)
}

const TITLE_TO_SIZE_KEY: Record<string, string> = {
  "½": "half", "1/2": "half", "half lb": "half", "halflb": "half",
  "30 ct box": "30pk", "15 ct box": "15pk", "30ct": "30pk", "15ct": "15pk",
}

export type PlannedShipping = { variant_id: string; cents: number; current: number | null }

export type ApplyShippingResult = {
  ok: boolean
  error?: string
  summary: { total_variants: number; updated: number; skipped: number; skip_reasons: Record<string, number> }
  planned?: PlannedShipping[]
}

/**
 * Stamp every variant of the profiles using `bucket` (all profiles when
 * omitted) with its rate. Variants with no rate are skipped and keep
 * what they have.
 */
export async function applyShippingRates(
  container: any,
  opts: { bucket?: string; dryRun?: boolean } = {},
): Promise<ApplyShippingResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const productService: any = container.resolve(Modules.PRODUCT)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const summary = { total_variants: 0, updated: 0, skipped: 0, skip_reasons: {} as Record<string, number> }
  const rates = (await settings.getSetting("shipping_rates")) as ShippingRates | null
  if (!rates || Object.keys(rates).length === 0) {
    return { ok: false, error: "shipping_rates setting is empty — save rates first.", summary }
  }

  const { profiles } = await loadProfiles(container)
  const inScope = profiles.filter((p) => p.shippingRatesKey && (!opts.bucket || p.shippingRatesKey === opts.bucket))
  const categories = await categoriesForProfiles(query, inScope)

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "sku", "weight", "metadata",
      "options.option.title", "options.value",
      "product.categories.id",
    ],
    filters: { deleted_at: null },
  })
  summary.total_variants = (variants as any[])?.length ?? 0
  const bumpSkip = (k: string) => { summary.skip_reasons[k] = (summary.skip_reasons[k] ?? 0) + 1; summary.skipped += 1 }

  const planned: PlannedShipping[] = []
  for (const v of (variants as any[]) ?? []) {
    const scoped = scopedCategoryOf(v.product, categories)
    if (!scoped) { bumpSkip("out_of_scope_category"); continue }
    const meta = (v.metadata ?? {}) as Record<string, any>

    const subKey = typeof meta.tier_key === "string" ? meta.tier_key : scoped.subcategory.key
    const sizes = new Set(scoped.subcategory.variants.map((d) => d.sizeKey))
    let size: string | null = typeof meta.size_key === "string" ? meta.size_key : null
    if (!size) {
      const fromSku = String(v.sku ?? "").toLowerCase().split("-").filter(Boolean).pop() ?? ""
      const sizeOpt = ((v.options ?? []) as any[]).find((o) => String(o?.option?.title ?? "").toLowerCase() === "size")
      const title = String(sizeOpt?.value ?? v.title ?? "").toLowerCase().trim()
      size = sizes.has(fromSku) ? fromSku : sizes.has(TITLE_TO_SIZE_KEY[title] ?? title) ? (TITLE_TO_SIZE_KEY[title] ?? title) : null
    }
    if (!size) { bumpSkip("unresolved_size"); continue }

    const dollars = rateForProfile(rates, scoped.profile, subKey, size)
    if (dollars == null) { bumpSkip("no_matching_rate"); continue }

    const cents = Math.round(dollars * 100)
    const current = v.weight == null ? null : Number(v.weight)
    planned.push({ variant_id: String(v.id), cents, current })
    if (current === cents && Number(meta.shipping_rate_usd) === dollars) { bumpSkip("already_current"); continue }
    if (opts.dryRun) { summary.updated += 1; continue }

    try {
      await productService.updateProductVariants(v.id, {
        weight: cents,
        metadata: { ...meta, shipping_rate_usd: dollars },
      })
      summary.updated += 1
    } catch (e: any) {
      logger.warn(`[shipping-rates/apply] variant ${v.id} update failed: ${e?.message}`)
      bumpSkip("update_failed")
    }
  }

  return { ok: true, summary, ...(opts.dryRun ? { planned } : {}) }
}

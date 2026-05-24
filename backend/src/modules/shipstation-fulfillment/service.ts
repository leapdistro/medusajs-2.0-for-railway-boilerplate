import { AbstractFulfillmentProviderService, ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import type {
  CalculateShippingOptionPriceDTO,
  CalculatedShippingOptionPrice,
  CreateShippingOptionDTO,
  FulfillmentOption,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"
import { getRates, rateCacheKey, type ShipStationService } from "../../lib/shipstation"

/**
 * Shape stashed on `shipping_option.data` when a calculated option is
 * created via seed-shipstation-options.ts. The provider reads it on
 * every calculatePrice to know which service to quote.
 */
type ShipStationOptionData = {
  service_code: ShipStationService
  label: string
}

/**
 * Per-process rate cache. We can't use Modules.CACHE from inside a
 * fulfillment provider — the awilix cradle is a Proxy and ANY property
 * access (even `cradle.cacheService`) becomes a `resolve()` call which
 * throws if the key isn't registered. Same gotcha as the payment
 * provider — see feedback_medusa_provider_cradle_proxy.md.
 *
 * In-process Map keyed by `zip:weight:declared_value:service` is enough
 * for our use case: Medusa calls calculatePrice once per shipping option
 * per cart recalc; cache lets the second option (NDA Saver) skip the API
 * after Ground populated both rates. Survives the entire backend process
 * lifetime; Railway redeploys flush it.
 */
const rateCache = new Map<string, { total: number; expiresAt: number }>()

function cacheGet(key: string): number | null {
  const entry = rateCache.get(key)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    rateCache.delete(key)
    return null
  }
  return entry.total
}

function cacheSet(key: string, total: number, ttlSec: number): void {
  rateCache.set(key, { total, expiresAt: Date.now() + ttlSec * 1000 })
}

/**
 * Shape we need from `cart` inside calculatePrice. Medusa hands us the
 * fully expanded cart with items + addresses, but we only need a small
 * slice — type defensively so missing fields don't crash on null.
 */
type CalcCart = {
  shipping_address?: {
    postal_code?: string | null
    country_code?: string | null
  } | null
  items?: Array<{
    quantity?: number
    variant?: {
      metadata?: Record<string, any> | null
    } | null
  }>
  subtotal?: number | string
  item_subtotal?: number | string
  raw_subtotal?: { value?: string | number } | string | number | null
}

/**
 * ShipStation fulfillment provider — backs the storefront's checkout
 * shipping picker with live UPS rates.
 *
 * Two options exposed:
 *   - ups_ground             → "UPS Ground"
 *   - ups_next_day_air_saver → "UPS Next Day Air Saver"
 *
 * On calculatePrice:
 *   1. Sum cart weight from variant.metadata.shipping_weight_lb.
 *      Hard-fails if any line item is missing the stamp — operator
 *      bulk-applies via MBS Settings → Shipping Weights → Apply to All.
 *   2. Declared value = 60% × cart subtotal.
 *   3. Cache lookup by (toZip, weight, dv); hit returns cheapest.
 *   4. Miss → ShipStation API → cache 10 min → return.
 *
 * Out of scope (separate slice): label creation on fulfillment. This
 * provider only quotes rates. createFulfillment / cancel / return are
 * no-op stubs that pass-through Medusa's lifecycle without touching
 * ShipStation — operator creates labels in the ShipStation UI as today.
 */
class ShipStationFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = "shipstation"

  /* Store the cradle reference (no property access in constructor — that
   * would trigger the awilix Proxy gotcha). We access Modules.PRODUCT
   * on it inside calculatePrice() to look up variant metadata, because
   * Medusa's calculatePrice context only includes variant.id, not the
   * full variant — even though we need metadata.shipping_weight_lb. */
  private readonly cradle_: any

  constructor(cradle?: any) {
    super()
    /* Critically: assignment-only, no property access. Accessing
     * a property on the Proxy triggers `resolve()` for that key; doing
     * it here for unregistered keys would crash provider registration.
     * Method-level access of KNOWN-registered services (Modules.PRODUCT
     * etc.) is fine and is the standard Medusa DI pattern. */
    this.cradle_ = cradle ?? null
  }

  /* ─── Static option list ──────────────────────────────────────── */

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    /* Two SKUs of shipping. ShipStation provides the rate at quote-time
     * — these options exist only so Medusa knows what to ask the
     * provider about. data.service_code is the dispatch key. */
    return [
      { id: "ups_ground",             name: "UPS Ground",                service_code: "ups_ground" },
      { id: "ups_next_day_air_saver", name: "UPS Next Day Air Saver",    service_code: "ups_next_day_air_saver" },
    ]
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    /* Accept any option whose data.service_code matches one of our two
     * services. seed-shipstation-options.ts stamps this — admin shouldn't
     * be hand-rolling these. */
    const sc = (data as ShipStationOptionData).service_code
    return sc === "ups_ground" || sc === "ups_next_day_air_saver"
  }

  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext,
  ): Promise<Record<string, unknown>> {
    /* No buyer-supplied data at checkout for shipping — return the
     * payload as-is. (Could carry "leave at door" or similar in future
     * but B2B wholesale doesn't need it.) */
    return data
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    /* All our options are calculated — no fixed/flat rate path. */
    return true
  }

  /* ─── Price calculation (the actual rate quote) ───────────────── */

  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"],
  ): Promise<CalculatedShippingOptionPrice> {
    const serviceCode = (optionData as unknown as ShipStationOptionData).service_code
    if (serviceCode !== "ups_ground" && serviceCode !== "ups_next_day_air_saver") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown ShipStation service_code on shipping option: ${String(serviceCode)}`,
      )
    }

    const cart = context as unknown as CalcCart
    const toZip = String(cart.shipping_address?.postal_code ?? "").trim()
    if (!toZip) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Shipping address postal code required before calculating shipping",
      )
    }

    /* Sum packaged shipping weight from variant.metadata.shipping_weight_lb.
     * Medusa's calculatePrice context only includes variant.id, not the
     * full variant — we look up metadata explicitly via the product
     * module. Hard-fail with a clear operator-actionable message if any
     * line is missing the stamp; buyer shouldn't be able to check out
     * with un-weighed merchandise (real cost would be a guess). */
    const variantIds = (cart.items ?? [])
      .map((it) => (it.variant as any)?.id ?? (it as any).variant_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)

    /* TEMP DIAGNOSTIC — dump the first item structure so we can see
     * what fields Medusa actually expands in the calculatePrice cart
     * context. Remove once we know the right path to variant metadata. */
    const firstItem = (cart.items ?? [])[0]
    if (firstItem) {
      const keys = Object.keys(firstItem as any).slice(0, 30)
      const variantKeys = firstItem.variant ? Object.keys(firstItem.variant as any).slice(0, 30) : []
      console.info(`[shipstation] DIAG item keys: ${keys.join(",")}`)
      console.info(`[shipstation] DIAG item.variant keys: ${variantKeys.join(",")}`)
      console.info(`[shipstation] DIAG item.variant.metadata: ${JSON.stringify((firstItem.variant as any)?.metadata ?? null).slice(0, 300)}`)
      console.info(`[shipstation] DIAG item.metadata: ${JSON.stringify((firstItem as any)?.metadata ?? null).slice(0, 300)}`)
    }

    let metadataByVariantId: Record<string, any> = {}
    console.info(`[shipstation] calculatePrice start: ${variantIds.length} variant(s), cradle=${this.cradle_ ? "yes" : "no"}`)
    if (variantIds.length > 0 && this.cradle_) {
      /* Medusa v2 enforces module isolation — cross-module DI is blocked
       * for direct service access. But the QUERY service is a top-level
       * framework registration (not a module) so it IS resolvable from
       * any cradle. Use it to graph-query the product_variant entity. */
      let queryService: any = null
      let resolveErr: string | null = null
      for (const key of [ContainerRegistrationKeys.QUERY, "remoteQuery", "query"]) {
        try {
          const s = this.cradle_[key]
          if (s && typeof s.graph === "function") {
            queryService = s
            console.info(`[shipstation] resolved query service via cradle["${key}"]`)
            break
          }
        } catch (e: any) {
          resolveErr = `${key}: ${e?.message}`
        }
      }
      if (!queryService) {
        console.warn(`[shipstation] could not resolve query service from cradle (last err: ${resolveErr ?? "none"})`)
      } else {
        try {
          const { data: variants } = await queryService.graph({
            entity: "product_variant",
            fields: ["id", "metadata"],
            filters: { id: variantIds },
          })
          console.info(`[shipstation] graph lookup returned ${variants?.length ?? 0} variant(s); sample=${JSON.stringify(variants?.[0] ?? {}).slice(0, 200)}`)
          for (const v of (variants as any[]) ?? []) {
            metadataByVariantId[v.id] = v.metadata ?? {}
          }
        } catch (e: any) {
          console.warn(`[shipstation] query.graph threw: ${e?.message}`)
        }
      }
    }

    let weightLbs = 0
    const missing: string[] = []
    for (const item of cart.items ?? []) {
      const qty = Number(item.quantity ?? 0)
      const vid = (item.variant as any)?.id ?? (item as any).variant_id
      const meta = metadataByVariantId[vid] ?? (item.variant?.metadata ?? {})
      const w = Number(meta?.shipping_weight_lb ?? 0)
      if (!Number.isFinite(w) || w <= 0) {
        missing.push((item.variant as any)?.title ?? vid ?? "(unknown variant)")
        continue
      }
      weightLbs += qty * w
    }
    if (missing.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Missing shipping weight on variant(s): ${missing.slice(0, 5).join(", ")}` +
        `${missing.length > 5 ? ` + ${missing.length - 5} more` : ""}. Set in MBS Settings → Shipping Weights → Apply to All Variants.`,
      )
    }
    if (weightLbs <= 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Cart total shipping weight is zero — cannot quote shipping",
      )
    }

    /* Declared value = 60% × cart subtotal. Medusa's subtotal field on
     * the cart context can be a number, a BigNumber-like, or absent on
     * draft carts; coerce defensively. */
    const subtotal = toAmount((cart as any).item_subtotal ?? cart.subtotal ?? (cart as any).raw_subtotal)
    const declaredValue = Math.max(1, Number((subtotal * 0.6).toFixed(2)))

    /* Cache key encodes everything that affects the quote — change
     * any input → fresh API call. 10-min TTL is enough to skip the
     * round-trip on rapid checkout-step recalculations (e.g. switching
     * Ground ↔ NDA toggles both options' calculate calls). */
    const reqShape = { toPostalCode: toZip, weightLbs: Number(weightLbs.toFixed(2)), declaredValue }
    const cacheKey = `${rateCacheKey(reqShape)}:${serviceCode}`
    const hit = cacheGet(cacheKey)
    if (hit !== null) {
      return { calculated_amount: hit, is_calculated_price_tax_inclusive: false }
    }

    const rates = await getRates(reqShape)
    const match = rates.find((r) => r.serviceCode === serviceCode)
    if (!match) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `ShipStation did not return a rate for ${serviceCode} (zip=${toZip}, weight=${weightLbs}). Try a different service or contact support.`,
      )
    }

    /* Cache BOTH services in one round-trip so the second calculatePrice
     * (Medusa calls once per shipping option) skips the API. */
    for (const r of rates) {
      cacheSet(`${rateCacheKey(reqShape)}:${r.serviceCode}`, r.total, 60 * 10)
    }

    return { calculated_amount: match.total, is_calculated_price_tax_inclusive: false }
  }

  /* ─── Lifecycle no-ops (label creation deferred) ─────────────── */

  async createFulfillment(...args: any[]): Promise<any> {
    /* No label creation in this slice — operator creates labels in the
     * ShipStation UI as today. Returning an empty data block lets
     * Medusa proceed with marking the fulfillment created. Signature
     * uses `...args` because the base class's CreateFulfillment signature
     * has drifted across Medusa v2 minors (date vs string canceled_at,
     * etc.); we don't read any of the inputs so an exact-match signature
     * isn't worth the brittleness. */
    void args
    return {}
  }

  async cancelFulfillment(...args: any[]): Promise<any> {
    void args
    return {}
  }

  async createReturnFulfillment(...args: any[]): Promise<any> {
    void args
    return {}
  }
}

/**
 * BigNumber-aware amount coercion. Mirrors the helper in the payment
 * provider — Medusa v2 hands monetary fields as plain number, string,
 * or a BigNumber object whose `.numeric` / `.value` carries the truth.
 */
function toAmount(value: unknown): number {
  if (value == null) return 0
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value) || 0
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    if (typeof o.numeric === "number") return o.numeric
    if (typeof o.value === "string") return Number(o.value) || 0
    if (typeof o.toNumber === "function") {
      const n = (o.toNumber as () => unknown).call(o)
      if (typeof n === "number") return n
    }
  }
  return 0
}

export default ShipStationFulfillmentService

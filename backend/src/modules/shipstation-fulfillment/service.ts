import { AbstractFulfillmentProviderService, MedusaError } from "@medusajs/framework/utils"
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

  protected readonly cache_: {
    get: (k: string) => Promise<unknown>
    set: (k: string, v: unknown, ttlSec?: number) => Promise<void>
  } | null

  constructor(cradle: any) {
    super()
    /* Cache module is registered by default in Medusa v2 (in-memory).
     * Pull it once from the cradle at construction — fulfillment providers
     * don't share the awilix-Proxy-on-resolve gotcha that bit the payment
     * provider (see feedback_medusa_provider_cradle_proxy.md); fulfillment
     * providers are constructed with a normal scoped cradle. Guard with
     * optional chaining anyway so a stripped-down test environment that
     * doesn't include the cache module still loads the service. */
    this.cache_ = cradle?.cacheService ?? cradle?.cache_service ?? null
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
     * Hard-fail with a clear operator-actionable message if any line is
     * missing the stamp — buyer shouldn't be able to check out with
     * un-weighed merchandise (real cost would be a guess). */
    let weightLbs = 0
    const missing: string[] = []
    for (const item of cart.items ?? []) {
      const qty = Number(item.quantity ?? 0)
      const w = Number(item.variant?.metadata?.shipping_weight_lb ?? 0)
      if (!Number.isFinite(w) || w <= 0) {
        missing.push((item.variant as any)?.title ?? (item.variant as any)?.id ?? "(unknown variant)")
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
    if (this.cache_) {
      const hit = await this.cache_.get(cacheKey).catch(() => null) as { total: number } | null
      if (hit && typeof hit.total === "number") {
        return { calculated_amount: hit.total, is_calculated_price_tax_inclusive: false }
      }
    }

    const rates = await getRates(reqShape)
    const match = rates.find((r) => r.serviceCode === serviceCode)
    if (!match) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `ShipStation did not return a rate for ${serviceCode} (zip=${toZip}, weight=${weightLbs}). Try a different service or contact support.`,
      )
    }

    if (this.cache_) {
      /* Cache BOTH services in one round-trip so the second
       * calculatePrice (Medusa calls once per shipping option) skips
       * the API. */
      await Promise.all(
        rates.map((r) =>
          this.cache_!.set(`${rateCacheKey(reqShape)}:${r.serviceCode}`, { total: r.total }, 60 * 10),
        ),
      )
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

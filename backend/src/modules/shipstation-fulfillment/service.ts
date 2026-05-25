import { AbstractFulfillmentProviderService, MedusaError } from "@medusajs/framework/utils"
import type {
  CalculateShippingOptionPriceDTO,
  CalculatedShippingOptionPrice,
  CreateShippingOptionDTO,
  FulfillmentOption,
  ValidateFulfillmentDataContext,
} from "@medusajs/framework/types"

/**
 * Shape stashed on `shipping_option.data` when the seed script creates
 * the calculated option. The provider reads it to know which option
 * Medusa is asking about (just one today — "standard"). Reserved for
 * future expansion if the operator wants e.g. an expedited tier.
 */
type FlatShippingOptionData = {
  service_code: "standard"
  label: string
}

type CalcCart = {
  items?: Array<{
    quantity?: number
    variant?: { weight?: number | string | null } | null
  }>
}

/**
 * MBS flat-rate-per-variant fulfillment provider.
 *
 * Pricing model: every variant carries its own shipping cost in CENTS
 * on the native `variant.weight` field (integer-safe and the only
 * Medusa column expanded in the calculatePrice cart context). The
 * provider sums `variant.weight × quantity` across the cart, divides
 * by 100, and returns dollars as the shipping total.
 *
 * Where rates come from: `mbs_settings.shipping_rates` is the operator
 * source of truth. Admin sets per-variant-type rates (QP/Half/LB/box)
 * in MBS Settings → Shipping Rates. Receiving-save stamps the rate on
 * new variants; the Apply to All button overwrites every matching
 * existing variant.
 *
 * Why repurpose variant.weight (an integer-named field) for shipping
 * cost cents: Medusa v2 module isolation blocks cross-module DI in
 * fulfillment providers, and the cart context doesn't expand custom
 * metadata. variant.weight IS expanded and IS integer-safe, so it's
 * the cheapest path to "provider can read per-variant value at quote
 * time without any cross-module gymnastics." The field name is a
 * compromise we accepted in trade for a much simpler architecture
 * than ShipStation live rates.
 *
 * Module file path is still `shipstation-fulfillment` for historical
 * reasons (and to avoid breaking medusa-config.js references); the
 * provider identifier is `shipstation` and the seeded option points
 * at `provider_id: "shipstation_shipstation"`. Rename in a follow-up
 * if/when we're sure we're not going back to ShipStation.
 */
class ShipStationFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = "shipstation"

  constructor() {
    super()
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      { id: "standard", name: "Standard Shipping", service_code: "standard" },
    ]
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return (data as FlatShippingOptionData).service_code === "standard"
  }

  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext,
  ): Promise<Record<string, unknown>> {
    return data
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"],
  ): Promise<CalculatedShippingOptionPrice> {
    const cart = context as unknown as CalcCart
    const items = cart.items ?? []

    /* Empty cart — valid mid-flow state (Medusa fires calculatePrice
     * during remove-last-item). Return 0; checkout-can-complete is
     * gated elsewhere. */
    if (items.length === 0) {
      return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
    }

    /* Sum per-variant rate cents × quantity. Any variant without a
     * stamped rate (variant.weight unset / 0) blocks checkout with a
     * clear operator-actionable error — better than silently shipping
     * for free. */
    let totalCents = 0
    const missing: string[] = []
    for (const item of items) {
      const qty = Number(item.quantity ?? 0)
      const cents = Number(item.variant?.weight ?? 0)
      if (!Number.isFinite(cents) || cents <= 0) {
        const v = item.variant as any
        missing.push(v?.title ?? v?.id ?? "(unknown variant)")
        continue
      }
      totalCents += qty * cents
    }
    if (missing.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Missing shipping rate on variant(s): ${missing.slice(0, 5).join(", ")}` +
        `${missing.length > 5 ? ` + ${missing.length - 5} more` : ""}. Set in MBS Settings → Shipping Rates → Apply to All Variants.`,
      )
    }

    return {
      calculated_amount: Math.round(totalCents) / 100,
      is_calculated_price_tax_inclusive: false,
    }
  }

  async createFulfillment(...args: any[]): Promise<any> {
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

export default ShipStationFulfillmentService

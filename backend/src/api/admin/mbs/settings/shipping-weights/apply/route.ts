import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { applyShippingRates } from "../../../../../../lib/shipping-rates"

/**
 * POST /admin/mbs/settings/shipping-weights/apply { bucket?, dryRun? }
 *
 * (Route path kept for backward compat with the admin UI's fetch URL —
 * functionality is now Shipping Rates, not weights.)
 *
 * Re-stamps per-variant shipping cost (variant.weight in cents, plus a
 * metadata.shipping_rate_usd mirror) on every variant of the categories
 * using `bucket` in shipping_rates, or every category when omitted.
 * Rates resolve through each variant's category profile
 * (lib/shipping-rates.ts); variants with no rate keep what they have.
 * dryRun returns `planned` and writes nothing.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { bucket?: unknown; dryRun?: unknown }
  const result = await applyShippingRates(req.scope, {
    bucket: typeof body.bucket === "string" && body.bucket ? body.bucket : undefined,
    dryRun: body.dryRun === true,
  })
  if (!result.ok) {
    res.status(400).json({ ok: false, message: result.error, summary: result.summary })
    return
  }
  res.json({ ok: true, summary: result.summary, ...(result.planned ? { planned: result.planned } : {}) })
}

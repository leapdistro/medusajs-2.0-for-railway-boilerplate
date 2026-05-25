import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/shipping-weights/apply
 *
 * (Route path kept for backward compat with the admin UI's fetch URL —
 * functionality is now Shipping Rates, not weights.)
 *
 * Bulk-stamps per-variant shipping cost on every Medusa variant whose
 * (tier × size) matches an entry in the `shipping_rates` setting.
 * Writes the dollar amount × 100 (cents) to native `variant.weight`
 * because:
 *   - variant.weight is integer-safe (Medusa's DML stores it as int)
 *   - variant.weight is the only column Medusa expands on items in the
 *     fulfillment provider's calculatePrice cart context
 *   - cents math avoids decimal truncation that bit us when we tried
 *     to store lbs (1.05 → 1)
 *
 * The provider divides by 100 at quote time. variant.metadata also
 * gets a human-readable `shipping_rate_usd` mirror so operators can
 * see the dollar value in the admin variant metadata view without
 * mental cents math.
 *
 * Resolution order per variant:
 *   1. metadata.tier_key + metadata.size_key → settings lookup
 *      (receiving-created variants)
 *   2. SKU prefix decode (QTR/HALF/FULL + CLA/EXO/SUP/SNO/RAP) →
 *      settings (legacy seed flower)
 *   3. existing metadata.shipping_weight_lb numeric value (read as
 *      dollars — operator-set rates from a prior session)
 */

type ShippingRates = {
  flower?: { qp?: number; half?: number; lb?: number }
  preroll?: Record<string, Record<string, number>>
}

const SKU_SIZE_MAP: Record<string, "qp" | "half" | "lb"> = {
  QTR:  "qp",
  HALF: "half",
  FULL: "lb",
}
const SKU_TIER_MAP: Record<string, "classic" | "exotic" | "super" | "snow" | "rapper"> = {
  CLA: "classic",
  EXO: "exotic",
  SUP: "super",
  SNO: "snow",
  RAP: "rapper",
}
function fromSku(sku: string | null | undefined): { tier: string; size: string } | null {
  if (!sku) return null
  const parts = sku.toUpperCase().split("-")
  if (parts.length < 2) return null
  const size = SKU_SIZE_MAP[parts[0]]
  const tier = SKU_TIER_MAP[parts[1]]
  if (!size || !tier) return null
  return { tier, size }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const productService: any = req.scope.resolve(Modules.PRODUCT)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const rates = (await settings.getSetting("shipping_rates")) as ShippingRates | null
  if (!rates || (!rates.flower && !rates.preroll)) {
    res.status(400).json({ ok: false, message: "shipping_rates setting is empty — save rates first." })
    return
  }

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "title", "sku", "weight", "metadata"],
    filters: { deleted_at: null },
  })

  let updated = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    const meta = (v.metadata ?? {}) as Record<string, any>

    let dollars: number | undefined
    const tier = typeof meta.tier_key === "string" ? meta.tier_key : null
    const size = typeof meta.size_key === "string" ? meta.size_key : null
    if (tier && size) {
      if (tier === "classic" || tier === "exotic" || tier === "super" || tier === "snow" || tier === "rapper") {
        dollars = (rates.flower as any)?.[size]
      } else {
        dollars = rates.preroll?.[tier]?.[size]
      }
    }
    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) {
      const resolved = fromSku(typeof v.sku === "string" ? v.sku : null)
      if (resolved) dollars = (rates.flower as any)?.[resolved.size]
    }
    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) {
      /* Last-resort: operator-set shipping_weight_lb metadata from a
       * prior session — treat the value as dollars now (the field
       * name is legacy; we ignore the "lb" semantics). */
      const fromMeta = Number(meta.shipping_weight_lb)
      if (Number.isFinite(fromMeta) && fromMeta > 0) dollars = fromMeta
    }

    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) {
      bumpSkip("no_matching_rate")
      continue
    }

    const cents = Math.round(dollars * 100)
    try {
      await productService.updateProductVariants(v.id, {
        weight: cents,
        metadata: { ...meta, shipping_rate_usd: dollars },
      })
      updated += 1
    } catch (e: any) {
      logger.warn(`[shipping-rates/apply] variant ${v.id} update failed: ${e?.message}`)
      bumpSkip("update_failed")
    }
  }

  res.json({
    ok: true,
    summary: {
      total_variants: (variants as any[])?.length ?? 0,
      updated,
      skipped,
      skip_reasons: skipReasons,
    },
  })
}

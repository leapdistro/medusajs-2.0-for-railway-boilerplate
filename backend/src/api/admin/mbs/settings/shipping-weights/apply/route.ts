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
  thcp_flower?: Record<string, Record<string, number>>
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
  if (!rates || (!rates.flower && !rates.preroll && !rates.thcp_flower)) {
    res.status(400).json({ ok: false, message: "shipping_rates setting is empty — save rates first." })
    return
  }

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "sku", "weight", "metadata",
      /* Needed for the category-based fallback: when a legacy variant
       * lacks tier_key/size_key metadata AND its SKU doesn't decode
       * (pre-rolls have no QTR/HALF/FULL prefix), match the variant's
       * product categories against the rates.preroll subcategory keys. */
      "product.categories.name",
    ],
    filters: { deleted_at: null },
  })

  function slugify(s: string): string {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  }

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
      } else if (tier === "thc-p") {
        /* THC-P Flower rides its own bucket — see receiving-save.ts
         * lookupShippingRate for the matching read path. */
        dollars = rates.thcp_flower?.[tier]?.[size]
      } else {
        dollars = rates.preroll?.[tier]?.[size]
      }
    }
    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) {
      const resolved = fromSku(typeof v.sku === "string" ? v.sku : null)
      if (resolved) dollars = (rates.flower as any)?.[resolved.size]
    }
    /* Category-based fallback for legacy pre-roll variants that have
     * no tier_key/size_key metadata AND no decodable SKU (e.g., the
     * seed-data GELATO KING product). Find a category whose slugified
     * name matches a key under rates.preroll; pick the FIRST sizeKey
     * configured under that subcategory as the variant's rate. Works
     * because operators currently configure one size per subcategory
     * (30pk for thc-a, 15pk for hashholes); if multi-size pre-roll
     * subcategories arrive later, this picks the first — operator
     * can manually override per variant. */
    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) {
      const cats = (v.product?.categories ?? []) as Array<{ name?: string }>
      for (const cat of cats) {
        const slug = slugify(String(cat.name ?? ""))
        const subRates = rates.preroll?.[slug]
        if (!subRates) continue
        const firstSizeKey = Object.keys(subRates).find((k) => Number(subRates[k]) > 0)
        if (firstSizeKey) {
          dollars = Number(subRates[firstSizeKey])
          break
        }
      }
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

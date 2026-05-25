import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/shipping-weights/apply
 *
 * Bulk-stamps PACKAGED shipping weight in LBS on every Medusa variant
 * whose metadata.tier_key + size_key matches an entry in the
 * `shipping_weights` setting. Path A migration (2026-05-25):
 *
 *   - Writes packaged LBS to native `variant.weight` (Medusa exposes
 *     this in the cart context that fulfillment providers see — the
 *     only way for the ShipStation provider to read shipping weight
 *     without tripping over Medusa v2's module isolation). ShipStation
 *     API takes pounds, so storing in lbs avoids any conversion step.
 *   - Mirrors the lbs value into `variant.metadata.shipping_weight_lb`
 *     as a human-readable backup (also shown in the operator-friendly
 *     metadata section of the variant detail page).
 *   - Net flower content (for storefront per-gram pricing) lives on
 *     `variant.metadata.net_grams` — populated by receiving-save on
 *     new variants AND by the one-time `backfill-net-grams.ts` script
 *     for legacy variants. This endpoint does NOT touch net_grams.
 *
 * Overwrite semantics: existing `variant.weight` value is replaced.
 * Run the backfill script BEFORE this endpoint so legacy net-grams
 * data (currently sitting on variant.weight pre-migration) isn't lost.
 *
 * Skipped:
 *   - Variants without metadata.tier_key + size_key (legacy seed
 *     products, or manually-created edibles / drinks / accessories).
 *   - Variants whose (tier_key, size_key) has no matching setting entry.
 */

type ShippingWeights = {
  flower?: { qp?: number; half?: number; lb?: number }
  preroll?: Record<string, Record<string, number>>
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const productService: any = req.scope.resolve(Modules.PRODUCT)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const weights = (await settings.getSetting("shipping_weights")) as ShippingWeights | null
  if (!weights || (!weights.flower && !weights.preroll)) {
    res.status(400).json({ ok: false, message: "shipping_weights setting is empty — save weights first." })
    return
  }

  /* Pull every variant with its metadata. Wildcards work on
   * product_variant; we only need a few fields. */
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "title", "sku", "weight", "metadata"],
    filters: { deleted_at: null },
  })

  /* SKU-pattern fallback table for legacy seed variants that have no
   * tier_key/size_key in metadata. Receiving-save SKUs encode tier +
   * size in fixed slots — `QTR-RAP-SAT-DUSDIA` = quarter, Rapper. */
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

  let updated = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    const meta = (v.metadata ?? {}) as Record<string, any>

    /* Weight resolution order (first match wins):
     *   1. metadata.tier_key + metadata.size_key → settings lookup
     *      (receiving-created variants)
     *   2. SKU prefix (QTR/HALF/FULL + CLA/EXO/SUP/SNO/RAP) → settings
     *      (legacy seed flower; covers products like DUSTY DIAMONDS)
     *   3. existing metadata.shipping_weight_lb (operator-manually-set;
     *      previous attempts to fill this in via the admin metadata
     *      panel before Path A moved storage to variant.weight)
     */
    let weight: number | undefined
    const tier = typeof meta.tier_key === "string" ? meta.tier_key : null
    const size = typeof meta.size_key === "string" ? meta.size_key : null
    if (tier && size) {
      if (tier === "classic" || tier === "exotic" || tier === "super" || tier === "snow" || tier === "rapper") {
        weight = (weights.flower as any)?.[size]
      } else {
        weight = weights.preroll?.[tier]?.[size]
      }
    }
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      const sku = typeof v.sku === "string" ? v.sku : null
      const resolved = fromSku(sku)
      if (resolved) {
        weight = (weights.flower as any)?.[resolved.size]
      }
    }
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      const fromMeta = Number(meta.shipping_weight_lb)
      if (Number.isFinite(fromMeta) && fromMeta > 0) weight = fromMeta
    }

    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      bumpSkip("no_matching_weight")
      continue
    }

    /* Write packaged LBS directly to variant.weight (read by the
     * ShipStation provider via the cart context — no conversion needed
     * since ShipStation API takes pounds). Mirror the same value to
     * metadata.shipping_weight_lb for admin visibility. */
    try {
      await productService.updateProductVariants(v.id, {
        weight: weight,
        metadata: { ...meta, shipping_weight_lb: weight },
      })
      updated += 1
    } catch (e: any) {
      logger.warn(`[shipping-weights/apply] variant ${v.id} update failed: ${e?.message}`)
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

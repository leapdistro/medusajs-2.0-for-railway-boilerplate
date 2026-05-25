import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/shipping-weights/apply
 *
 * Bulk-stamps PACKAGED shipping weight on every Medusa variant whose
 * metadata.tier_key + size_key matches an entry in the `shipping_weights`
 * setting. Path A migration (2026-05-25):
 *
 *   - Writes PACKAGED GRAMS to native `variant.weight` (Medusa exposes
 *     this in the cart context that fulfillment providers see — only
 *     way for the ShipStation provider to read shipping weight without
 *     tripping over Medusa v2's module isolation).
 *   - Mirrors the lbs value into `variant.metadata.shipping_weight_lb`
 *     as a human-readable reference for admin operators.
 *   - Net flower content (for storefront per-gram pricing) lives on
 *     `variant.metadata.net_grams` — populated by receiving-save on new
 *     variants AND by the one-time `backfill-net-grams.ts` script for
 *     legacy variants. This endpoint does NOT touch net_grams.
 *
 * Overwrite semantics: existing `variant.weight` value is replaced.
 * Run the backfill script BEFORE this endpoint so legacy net_grams
 * data isn't lost.
 *
 * Skipped:
 *   - Variants without metadata.tier_key + size_key (legacy seed
 *     products, or manually-created edibles / drinks / accessories).
 *   - Variants whose (tier_key, size_key) has no matching setting entry.
 *
 * Returns counts so the admin UI can render a "47 updated, 12 skipped"
 * confirmation toast.
 */

const GRAMS_PER_LB = 453.59237

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
    fields: ["id", "title", "metadata"],
    filters: { deleted_at: null },
  })

  let updated = 0
  let skipped = 0
  const skipReasons: Record<string, number> = {}
  const bumpSkip = (k: string) => { skipReasons[k] = (skipReasons[k] ?? 0) + 1; skipped += 1 }

  for (const v of (variants as any[]) ?? []) {
    const meta = (v.metadata ?? {}) as Record<string, any>
    const tier = typeof meta.tier_key === "string" ? meta.tier_key : null
    const size = typeof meta.size_key === "string" ? meta.size_key : null
    if (!tier || !size) {
      bumpSkip("no_tier_or_size_key")
      continue
    }

    /* Lookup precedence: flower keys are the 3 fixed sizes; pre-roll
     * keys nest under (subcategoryKey → sizeKey). The receiving profile
     * uses the same tier_key namespace for both ("classic"/"exotic"/...
     * for flower; "thc-a"/"hashholes"/... for pre-roll), so a single
     * tier_key value disambiguates which sub-tree to read. */
    let weight: number | undefined
    if (tier === "classic" || tier === "exotic" || tier === "super" || tier === "snow" || tier === "rapper") {
      weight = (weights.flower as any)?.[size]
    } else {
      weight = weights.preroll?.[tier]?.[size]
    }

    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      bumpSkip("no_matching_weight")
      continue
    }

    /* Write PACKAGED grams to variant.weight (read by ShipStation
     * provider via the cart context), and mirror the lbs value to
     * metadata for human-readable reference. */
    const packagedGrams = Math.round(weight * GRAMS_PER_LB * 100) / 100
    try {
      await productService.updateProductVariants(v.id, {
        weight: packagedGrams,
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

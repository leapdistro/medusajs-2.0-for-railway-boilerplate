import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../../modules/mbs-settings"

/**
 * POST /admin/mbs/settings/shipping-weights/apply
 *
 * Bulk-stamps `variant.metadata.shipping_weight_lb` on every Medusa
 * variant whose metadata.tier_key + size_key matches an entry in the
 * `shipping_weights` setting. Overwrites existing values (operator
 * accepted overwrite semantics — see the design conversation).
 *
 * Stored separately from the native `variant.weight` field because
 * that one carries net flower content in grams for the storefront's
 * per-gram math; shipping weight is a different concept (packaged,
 * in lbs).
 *
 * Skipped:
 *   - Variants without metadata.tier_key + size_key (manually-created
 *     non-flower / non-pre-roll products like edibles / drinks).
 *   - Variants whose (tier_key, size_key) has no matching setting
 *     entry (e.g., a custom pre-roll subcategory not yet weighted —
 *     operator needs to add it to the setting first).
 *
 * Returns counts so the admin UI can render a "47 updated, 12 skipped"
 * confirmation toast.
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

    try {
      await productService.updateProductVariants(v.id, {
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

import { model } from "@medusajs/framework/utils"

/* `tier` was removed from this module on 2026-04-25 — it now derives from
 * the product's sub-category assignment (single source of truth). The
 * legacy TIER_VALUES export is gone. Storefront reads tier via
 * category.metadata.tier_key (preferred) or category handle (fallback). */
export const STRAIN_TYPE_VALUES = ["Indica", "Sativa", "Hybrid"] as const
export const BEST_FOR_VALUES = ["day", "evening", "night"] as const
export const EFFECT_VALUES = [
  "Chill",
  "Energy",
  "Relief",
  "Sleep",
  "Focus",
  "Grounded",
  "Creative",
  "Social",
  "Calm",
] as const

export const ProductAttributes = model.define("product_attributes", {
  id: model.id().primaryKey(),
  strain_type: model.enum([...STRAIN_TYPE_VALUES]).nullable(),
  best_for: model.enum([...BEST_FOR_VALUES]).nullable(),
  potency: model.number().nullable(),
  thca_percent: model.text().nullable(),
  total_cannabinoids_percent: model.text().nullable(),
  effects: model.json().nullable(),
  coa_url: model.text().nullable(),
  /* Lab batch / sample / test ID extracted from the COA at receiving.
   * Free-form text — labs use varied formats (e.g. "S-12345", "1A4-N7-K2",
   * "Sample #2024-0098"). Printed on the wholesale label so buyers can
   * cross-reference the original COA. */
  batch_id: model.text().nullable(),
  /* Per-cannabinoid % fields — populated by receiving based on the
   * product's flower branch. Adapter falls back to thca_percent if the
   * branch-specific field is null so legacy records keep displaying. All
   * nullable — a THC-A product has no cbd_percent, and vice versa.
   * d9_percent stays nullable for every branch (used by CBD/CBG Texas
   * total-THC compliance line but also renderable on THC-A COAs). */
  cbd_percent: model.text().nullable(),
  cbg_percent: model.text().nullable(),
  thcp_percent: model.text().nullable(),
  d9_percent: model.text().nullable(),
})

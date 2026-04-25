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
})

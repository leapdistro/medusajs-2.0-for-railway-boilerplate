import { model } from "@medusajs/framework/utils"

export const TIER_VALUES = ["classic", "exotic", "super", "rapper", "snow"] as const
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
  tier: model.enum(TIER_VALUES).nullable(),
  strain_type: model.enum(STRAIN_TYPE_VALUES).nullable(),
  best_for: model.enum(BEST_FOR_VALUES).nullable(),
  potency: model.number().nullable(),
  thca_percent: model.text().nullable(),
  total_cannabinoids_percent: model.text().nullable(),
  effects: model.json().nullable(),
  coa_url: model.text().nullable(),
})

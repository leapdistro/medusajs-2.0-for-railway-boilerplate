export type StrainType = "Indica" | "Sativa" | "Hybrid"
export type Tier = "classic" | "exotic" | "super" | "rapper" | "snow"
export type Category = "flower" | "pre-rolls"
export type BestFor = "day" | "evening" | "night"
export type Effect =
  | "Chill" | "Energy" | "Relief" | "Sleep" | "Focus"
  | "Grounded" | "Creative" | "Social" | "Calm"

export type MbsSeedProduct = {
  slug: string
  name: string
  category: Category
  tier: Tier
  strain: StrainType
  thcaPercent: string                 // e.g. "26.4"
  cannabinoidsPercent: string         // e.g. "24.3"
  potency: 1 | 2 | 3
  bestFor: BestFor
  effects: [Effect, Effect]
  weights: string[]                   // ["qp","half","lb"] or ["box of 30"] etc.
}

export const MBS_PRODUCTS: MbsSeedProduct[] = [
  // ────── Flower ──────
  { slug: "northern-lights",   name: "Northern Lights",   category: "flower", tier: "classic", strain: "Indica", thcaPercent: "26.4", cannabinoidsPercent: "24.3", potency: 2, bestFor: "night",   effects: ["Sleep", "Relief"],     weights: ["qp", "half", "lb"] },
  { slug: "white-widow",       name: "White Widow",       category: "flower", tier: "classic", strain: "Hybrid", thcaPercent: "19.6", cannabinoidsPercent: "18.0", potency: 2, bestFor: "day",     effects: ["Energy", "Social"],    weights: ["qp", "half", "lb"] },
  { slug: "strawberry-cough",  name: "Strawberry Cough",  category: "flower", tier: "exotic",  strain: "Sativa", thcaPercent: "24.6", cannabinoidsPercent: "22.6", potency: 2, bestFor: "day",     effects: ["Social", "Creative"],  weights: ["qp", "half", "lb"] },
  { slug: "wedding-cake",      name: "Wedding Cake",      category: "flower", tier: "exotic",  strain: "Hybrid", thcaPercent: "26.2", cannabinoidsPercent: "24.1", potency: 3, bestFor: "night",   effects: ["Chill", "Relief"],     weights: ["qp", "half", "lb"] },
  { slug: "lemon-cherry-gas",  name: "Lemon Cherry Gas",  category: "flower", tier: "super",   strain: "Hybrid", thcaPercent: "29.1", cannabinoidsPercent: "26.8", potency: 3, bestFor: "day",     effects: ["Energy", "Focus"],     weights: ["qp", "half", "lb"] },
  { slug: "apricot-gelato",    name: "Apricot Gelato",    category: "flower", tier: "super",   strain: "Hybrid", thcaPercent: "31.4", cannabinoidsPercent: "28.9", potency: 3, bestFor: "evening", effects: ["Creative", "Calm"],    weights: ["qp", "half", "lb"] },
  { slug: "pineapple-express", name: "Pineapple Express", category: "flower", tier: "rapper",  strain: "Sativa", thcaPercent: "32.8", cannabinoidsPercent: "30.2", potency: 3, bestFor: "day",     effects: ["Energy", "Creative"],  weights: ["qp", "half", "lb"] },
  { slug: "snowcaps-og",       name: "Snowcaps OG",       category: "flower", tier: "snow",    strain: "Indica", thcaPercent: "28.5", cannabinoidsPercent: "26.2", potency: 3, bestFor: "night",   effects: ["Sleep", "Calm"],       weights: ["qp", "half", "lb"] },

  // ────── Pre-Rolls ──────
  { slug: "thca-classic-blend", name: "THC-A Classic Blend",     category: "pre-rolls", tier: "classic", strain: "Hybrid", thcaPercent: "18.4", cannabinoidsPercent: "16.9", potency: 2, bestFor: "evening", effects: ["Chill", "Social"],     weights: ["box of 30"] },
  { slug: "thca-exotic-blend",  name: "THC-A Exotic Blend",      category: "pre-rolls", tier: "exotic",  strain: "Sativa", thcaPercent: "22.1", cannabinoidsPercent: "20.3", potency: 2, bestFor: "day",     effects: ["Energy", "Creative"],  weights: ["box of 30"] },
  { slug: "hashholes-indica",   name: "Hashholes — Indica Blend", category: "pre-rolls", tier: "rapper",  strain: "Indica", thcaPercent: "38.6", cannabinoidsPercent: "35.5", potency: 3, bestFor: "night",   effects: ["Relief", "Sleep"],     weights: ["box of 15"] },
  { slug: "hashholes-hybrid",   name: "Hashholes — Hybrid Blend", category: "pre-rolls", tier: "rapper",  strain: "Hybrid", thcaPercent: "36.9", cannabinoidsPercent: "34.0", potency: 3, bestFor: "evening", effects: ["Chill", "Grounded"],   weights: ["box of 15"] },
]

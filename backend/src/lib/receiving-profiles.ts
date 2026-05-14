/**
 * Receiving profiles — the data shape that lets one orchestrator handle
 * multiple product categories (Flower, Pre-Rolls, ... eventually Drinks /
 * Edibles / Accessories). Each profile declares:
 *
 *   - Which Medusa category the products land under (top-level + sub)
 *   - The variant axes (size key, display label, pool-unit multiplier,
 *     optional weight)
 *   - Which review-grid fields are required (strain type? COA? cannabinoids?)
 *   - The pricing model (tier price list vs flat per-variant)
 *
 * Slice R1 of the receiving generalization (2026-05-14): introduce the
 * abstraction. Slice R2 refactors receiving-save.ts to read from it.
 * Slice R3+ wires the receiving Upload page to a category selector and
 * adds the Pre-Roll review/save path.
 *
 * Why a config-driven shape instead of a class hierarchy: the per-
 * category surface is small (~10 fields) and largely declarative. A
 * config keeps the diff focused when adding the next category.
 */

export type ProfileKey = "flower" | "pre-roll"

/** A variant axis value (one row in the review grid maps to N variants per profile). */
export type VariantDef = {
  /** Stable identifier — also the size suffix on the variant SKU (qp/half/lb/30pk/...). */
  sizeKey: string
  /** Display label shown in admin + storefront variant picker ("QP", "½", "30 ct Box"). */
  label: string
  /** required_quantity on the variant→inventory_item link. Pool consumption per variant unit.
   *  Flower QP=1 / Half=2 / LB=4; Pre-Rolls 30 ct Box=1 (one variant = one box). */
  multiplier: number
  /** Variant weight in grams. Drives margin calc + ShipStation. Undefined when not applicable. */
  grams?: number
}

/** A sub-category the operator picks per row. Resolves to a Medusa product_category by name. */
export type SubcategoryDef = {
  /** Stable lowercase key (classic/exotic/...thc-a/hashholes/...) — used for metadata + SKUs. */
  key: string
  /** Exact name of the Medusa product_category to attach the product to. Must already exist. */
  medusaName: string
  /** Human label in admin UI. */
  label: string
  /** Optional per-subcategory variant override. When set, overrides
   *  profile.variants for products in this subcategory. Used when
   *  subcategories diverge on packaging (e.g., Pre-Rolls THC-A is
   *  30 ct boxes while Hashholes is 15 ct boxes). When unset, falls
   *  back to profile.variants (flower's QP/Half/LB are shared across
   *  all tier subcategories). */
  variants?: VariantDef[]
}

/** Where the variant selling price comes from. */
export type PricingModel =
  /** Lookup in mbs-settings "flower_tier_prices" — { qp, half, lb } per tier. */
  | "tier"
  /** Operator types a single price per row that applies to the (single) variant. */
  | "flat"

/** Which optional fields the review grid surfaces / requires. */
export type ProfileFields = {
  /** Indica / Sativa / Hybrid dropdown */
  strainType: boolean
  /** day / evening / night dropdown */
  bestFor: boolean
  /** array of effects (Chill / Energy / etc.) */
  effects: boolean
  /** THCa % + total cannabinoids % numeric inputs */
  cannabinoids: boolean
  /** COA PDF upload required for compliance */
  coaRequired: boolean
  /** UPC barcode text input — when true, receiving form shows a UPC
   *  field per row and saves to variant.barcode. PDP shows "UPC: XXXX"
   *  under product title. Pre-Rolls + any future subcat under it. */
  upc: boolean
}

export type ReceivingProfile = {
  key: ProfileKey
  /** "Flower", "Pre-Rolls" — title-cased category for UI + Medusa parent category name. */
  displayName: string
  /** Top-level Medusa product_category name (parent). Must already exist in catalog. */
  parentCategoryName: string
  /** Sub-categories the operator picks per row. Resolved to category IDs via Medusa query. */
  subcategories: SubcategoryDef[]
  /** Variant axis values. N variants get created per row, sharing one InventoryItem (pool). */
  variants: VariantDef[]
  /** Field gating for the review grid. */
  fields: ProfileFields
  pricingModel: PricingModel
  /** UI labels for the pool unit ("QP"/"QPs" for flower, "Box"/"Boxes" for pre-rolls). Used in
   *  receiving-history table headers + admin widgets. */
  unitLabel: { singular: string; plural: string }
  /** UI label for the operator's input quantity unit — what they type per row.
   *  Flower: "lb" (operator buys by the pound, system multiplies to QPs).
   *  Pre-rolls: "box" (1 box of input = 1 box of pool). */
  inputUnitLabel: { singular: string; plural: string }
  /** Multiplier from the operator-typed input unit → pool unit. Flower: 4
   *  (1 lb = 4 QPs). Pre-rolls: 1 (1 box = 1 box). Drives both the pool
   *  stocked-quantity write and the landed-cost-per-pool-unit math. */
  inputToPoolMultiplier: number
}

/* ─── Flower ─── */

export const FLOWER_PROFILE: ReceivingProfile = {
  key: "flower",
  displayName: "Flower",
  parentCategoryName: "Flower",
  subcategories: [
    /* `medusaName` matches seed-flower-categories.ts. `snow` keeps the legacy
     * "Snowcaps" label so we don't create a duplicate category. */
    { key: "classic", medusaName: "Classic",  label: "Classic" },
    { key: "exotic",  medusaName: "Exotic",   label: "Exotic" },
    { key: "super",   medusaName: "Super",    label: "Super" },
    { key: "snow",    medusaName: "Snowcaps", label: "Snowcaps" },
    { key: "rapper",  medusaName: "Rapper",   label: "Rapper" },
  ],
  variants: [
    /* Pool counts in QPs. 1 lb = 4 QPs ≈ 454g. Variants share the
     * inventory item via required_quantity. */
    { sizeKey: "qp",   label: "QP", multiplier: 1, grams: 113 },
    { sizeKey: "half", label: "½",  multiplier: 2, grams: 227 },
    { sizeKey: "lb",   label: "LB", multiplier: 4, grams: 454 },
  ],
  fields: {
    strainType: true,
    bestFor: true,
    effects: true,
    cannabinoids: true,
    coaRequired: true,
    upc: false,
  },
  pricingModel: "tier",
  unitLabel: { singular: "QP", plural: "QPs" },
  inputUnitLabel: { singular: "lb", plural: "lbs" },
  inputToPoolMultiplier: 4,
}

/* ─── Pre-Rolls ─── */

export const PREROLL_PROFILE: ReceivingProfile = {
  key: "pre-roll",
  displayName: "Pre-Rolls",
  parentCategoryName: "Pre-Rolls",
  subcategories: [
    /* Per-subcategory variants: THC-A boxes hold 30 individual pre-rolls;
     * Hashholes boxes hold 15 tubes (2 hashholes per tube). Pool counts
     * in BOXES for both — operator orders + sells boxes, multiplier=1. */
    {
      key: "thc-a",
      medusaName: "THC-A",
      label: "THC-A",
      variants: [{ sizeKey: "30pk", label: "30 ct Box", multiplier: 1 }],
    },
    {
      key: "hashholes",
      medusaName: "Hashholes",
      label: "Hashholes",
      variants: [{ sizeKey: "15pk", label: "15 ct Box", multiplier: 1 }],
    },
  ],
  /* Empty fallback — every Pre-Roll subcategory must declare its own
   * variants. Receiving-save will throw if it tries to use this. */
  variants: [],
  fields: {
    strainType: true,
    bestFor: true,
    effects: true,
    cannabinoids: true,
    coaRequired: true,
    /* Pre-Rolls (and future subcategories under it) get a UPC field
     * on the receiving form + UPC display on the storefront PDP. */
    upc: true,
  },
  /* Each row carries its own price (operator types it). No tier table. */
  pricingModel: "flat",
  unitLabel: { singular: "Box", plural: "Boxes" },
  inputUnitLabel: { singular: "box", plural: "boxes" },
  inputToPoolMultiplier: 1,
}

/* ─── Registry ─── */

export const PROFILES: Record<ProfileKey, ReceivingProfile> = {
  flower: FLOWER_PROFILE,
  "pre-roll": PREROLL_PROFILE,
}

export function getProfile(key: ProfileKey): ReceivingProfile {
  const p = PROFILES[key]
  if (!p) throw new Error(`Unknown receiving profile: ${key}`)
  return p
}

/** Find the SubcategoryDef whose key matches; throws if not found. */
export function getSubcategory(profile: ReceivingProfile, key: string): SubcategoryDef {
  const sub = profile.subcategories.find((s) => s.key === key)
  if (!sub) {
    throw new Error(`Subcategory "${key}" not configured on profile "${profile.key}"`)
  }
  return sub
}

/** Find a variant def by sizeKey; throws if not found. */
export function getVariantDef(profile: ReceivingProfile, sizeKey: string): VariantDef {
  const v = profile.variants.find((vd) => vd.sizeKey === sizeKey)
  if (!v) throw new Error(`Variant "${sizeKey}" not configured on profile "${profile.key}"`)
  return v
}

/** Resolve the active variants for a row: subcategory override (if any)
 *  takes precedence over profile.variants. Throws if neither is set. */
export function getVariantsForRow(
  profile: ReceivingProfile,
  subcategoryKey: string,
): VariantDef[] {
  const sub = getSubcategory(profile, subcategoryKey)
  const variants = sub.variants && sub.variants.length > 0 ? sub.variants : profile.variants
  if (variants.length === 0) {
    throw new Error(
      `No variants configured for "${profile.key}" subcategory "${subcategoryKey}". Set on the subcategory or profile.`,
    )
  }
  return variants
}

/**
 * SKU generation — single source of truth for the variant SKU pattern.
 *
 * Pattern (locked 2026-05-12, branch slot added 2026-08):
 *
 *   <cat-3>-<branch-3>?-<subcat-3>-<type-3>?-<strain-abbrev>?-<size>
 *
 *   cat-3      First 3 alphanumeric chars of the category name (Flower → flo,
 *              Pre-Rolls → pre, Drinks → dri).
 *   branch-3   Optional cannabinoid branch (CBD → cbd, CBG → cbg). Inserted
 *              only when the receiving profile declares qboCategoryBranch —
 *              disambiguates CBD Classic Blue Dream from THC-A Classic Blue
 *              Dream, which would otherwise generate the same SKU and
 *              collide on the DB variant.sku unique constraint. THC-A
 *              leaves it undefined so existing SKUs stay identical (no
 *              migration).
 *   subcat-3   Same rule on the sub-category (Super → sup, THC-A → thc,
 *              Hashholes → has, Snowcaps → sno).
 *   type-3     First 3 chars of the strain type if applicable
 *              (Indica → ind, Sativa → sat, Hybrid → hyb). Omitted for
 *              categories with no notion of strain type (drinks, etc.).
 *   strain     Strain name with first-3-of-each-word abbreviation, hyphenated:
 *              "Pineapple Express" → "pin-exp"
 *              "Gold Rose Runtz"   → "gol-ros-run"
 *              "GG4"               → "gg4"
 *              Omitted for non-strain products.
 *   size       Variant size identifier from the variant itself, lowercased
 *              (qp / half / lb / 30pk / 12oz / etc.).
 *
 * Examples:
 *   flo-sup-hyb-pin-exp-qp                  — QP of Pineapple Express (Super, Hybrid)
 *   flo-cla-ind-gol-ros-run-half            — Half of Gold Rose Runtz (Classic, Indica)
 *   flo-cbd-cla-hyb-blu-dre-qp              — QP of Blue Dream, CBD Classic (branch slot set)
 *   flo-cbg-sup-ind-pur-kus-lb              — LB of Purple Kush, CBG Super
 *   pre-thc-sat-pin-exp-30pk                — 30-pack pre-rolls of Pineapple Express
 *   dri-sod-12oz                            — 12oz Soda (no type, no strain)
 *
 * QBO Item SKU uses baseSku() — the size-stripped form ("flo-sup-hyb-pin-exp")
 * — because one QBO Item represents the strain+tier as a whole (in QP units
 * for flower), not a single variant.
 */

export function abbrev3(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 3)
}

/**
 * Subcategory abbreviation overrides — collision-avoidance for
 * subcategories whose generic first-3-alphanum collapse would produce
 * the same key. Applied ONLY to the subcategory slot in generateSku;
 * abbrev3 elsewhere (category, type) stays purely mechanical.
 *
 * Locked map:
 *   THC-A → thc   (baseline; predates split, preserves legacy SKUs)
 *   THC-P → thp   (added when Flower split into THC-A / THC-P;
 *                  generic abbrev3 would produce "thc" and collide)
 */
const SUBCAT_ABBREV_OVERRIDES: Record<string, string> = {
  "thc-p": "thp",
}

function subcatAbbrev(s: string | null | undefined): string {
  const raw = (s ?? "").toLowerCase().trim()
  const override = SUBCAT_ABBREV_OVERRIDES[raw]
  if (override) return override
  return abbrev3(raw)
}

/**
 * Split on word boundaries (whitespace, hyphens, underscores) and take
 * first 3 alphanumeric chars from each word, hyphenated.
 */
export function strainAbbrev(strain: string | null | undefined): string {
  return (strain ?? "")
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, "").slice(0, 3))
    .filter((w) => w.length > 0)
    .join("-")
}

export type SkuParts = {
  category: string                        // top-level (Flower, Pre-Rolls, Drinks, ...)
  /** Optional cannabinoid branch (CBD, CBG). Sourced from
   *  ReceivingProfile.qboCategoryBranch — undefined for THC-A so
   *  existing SKUs remain byte-identical. When set, injects a
   *  branch-3 segment between the cat-3 and subcat-3 slots. */
  branch?: string | null
  subcategory: string                     // tier or sub-category (Super, THC-A, Soda, ...)
  type?: string | null                    // Indica/Sativa/Hybrid, or null if N/A
  strain?: string | null                  // strain name, or null if N/A
  size?: string | null                    // variant size (qp, half, lb, 30pk, ...) — for variant SKU
}

export function generateSku(parts: SkuParts): string {
  const segs: string[] = []
  const cat = abbrev3(parts.category)
  if (cat) segs.push(cat)
  if (parts.branch) {
    const b = abbrev3(parts.branch)
    if (b) segs.push(b)
  }
  const sub = subcatAbbrev(parts.subcategory)
  if (sub) segs.push(sub)
  if (parts.type) {
    const t = abbrev3(parts.type)
    if (t) segs.push(t)
  }
  if (parts.strain) {
    const s = strainAbbrev(parts.strain)
    if (s) segs.push(s)
  }
  if (parts.size) segs.push(parts.size.toLowerCase())
  return segs.join("-")
}

/**
 * Same parts as generateSku but with `size` always omitted. Used for QBO
 * Items where one item represents the strain+tier as a whole.
 */
export function baseSku(parts: Omit<SkuParts, "size">): string {
  return generateSku({ ...parts, size: undefined })
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { getProfile, type ProfileKey, type SubcategoryDef, type VariantDef } from "../../../../../lib/receiving-profiles"

/**
 * GET /admin/receiving/profile/:key
 *
 * Returns the ReceivingProfile config MERGED with live Medusa categories
 * under the profile's parent — so adding a new sub-category in the
 * Medusa admin shows up in the receiving page dropdown automatically,
 * with NO code change required.
 *
 * Merge rules per Medusa child category:
 *   - If category.name matches profile.subcategories[i].medusaName,
 *     return the profile entry verbatim (variants + label as configured).
 *   - Else, derive a default entry:
 *       key   = slugified category.name
 *       label = category.name
 *       variants = category.metadata.variants if set, else
 *                  profile.variants if non-empty (flower fallback), else
 *                  a single { sizeKey: "default", label: "Unit", multiplier: 1 }
 *
 * This keeps profile.subcategories as the "rich override" location (for
 * subcats with non-default variants like Pre-Rolls' 30/15 ct boxes) and
 * defers to Medusa for the existence list.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const key = req.params.key as ProfileKey
  let profile
  try {
    profile = getProfile(key)
  } catch (e: any) {
    return res.status(404).json({ error: e?.message ?? `Unknown profile: ${key}` })
  }

  /* Fetch all Medusa categories so we can find the parent + its children. */
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id", "metadata"],
  })
  const cats = (allCats as Array<{ id: string; name: string; handle?: string; parent_category_id?: string | null; metadata?: any }>) ?? []
  const parent = cats.find((c) => c.name === profile.parentCategoryName && !c.parent_category_id)
  if (!parent) {
    /* Parent category missing in Medusa — return profile config as-is.
     * Receiving save will throw with a clear seed-script error anyway. */
    return res.json({ profile, source: "profile-only" })
  }
  const children = cats.filter((c) => c.parent_category_id === parent.id)

  /* Merge: live children drive the list; profile entries override
   * default derivations when names match. Profile-only entries (those
   * with no matching Medusa category) are dropped — having a profile
   * entry without a real category in Medusa means receiving would fail
   * to attach products anyway. */
  const merged: SubcategoryDef[] = children.map((cat) => {
    const profileMatch = profile.subcategories.find((s) => s.medusaName === cat.name)
    if (profileMatch) {
      /* If the subcategory declares its own variants (pre-roll case
       * where each subcat has different pack sizes), use those.
       * Otherwise fall back to profile.variants — mirrors
       * getVariantsForRow so the admin UI sees the same variant list
       * receiving-save will use. Without this, THC-P Flower's single
       * subcategory (which relies on profile.variants) came back with
       * no variants and hung the settings + receiving admin. */
      if (profileMatch.variants && profileMatch.variants.length > 0) {
        return profileMatch
      }
      return { ...profileMatch, variants: profile.variants }
    }

    /* Default derivation for unknown-to-profile categories. */
    const fromMeta = parseVariantsFromCategoryMetadata(cat.metadata)
    const fallbackVariants = fromMeta
      ?? (profile.variants.length > 0 ? profile.variants : [defaultVariantDef()])
    return {
      key: slugifyKey(cat.name),
      medusaName: cat.name,
      label: cat.name,
      variants: fallbackVariants,
    }
  })

  return res.json({
    profile: { ...profile, subcategories: merged },
    source: "merged",
  })
}

function slugifyKey(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "default"
}

function defaultVariantDef(): VariantDef {
  return { sizeKey: "default", label: "Unit", multiplier: 1 }
}

/* Operator can set category.metadata.variants on the Medusa category to
 * override defaults for a new subcategory without touching code. Shape:
 *   { variants: [{ sizeKey, label, multiplier, grams? }] }
 * Quietly drops malformed entries. */
function parseVariantsFromCategoryMetadata(meta: any): VariantDef[] | null {
  const raw = meta?.variants
  if (!Array.isArray(raw) || raw.length === 0) return null
  const cleaned: VariantDef[] = []
  for (const v of raw) {
    const sizeKey = String(v?.sizeKey ?? "").trim()
    const label = String(v?.label ?? "").trim()
    const multiplier = Number(v?.multiplier ?? 1)
    if (!sizeKey || !label || !Number.isFinite(multiplier) || multiplier <= 0) continue
    const grams = Number.isFinite(Number(v?.grams)) ? Number(v.grams) : undefined
    cleaned.push({ sizeKey, label, multiplier, ...(grams !== undefined ? { grams } : {}) })
  }
  return cleaned.length > 0 ? cleaned : null
}

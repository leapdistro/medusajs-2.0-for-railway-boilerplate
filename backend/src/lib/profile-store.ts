import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import {
  PROFILES,
  type PriceTables,
  type PricingModel,
  type ReceivingProfile,
  type SubcategoryDef,
  type VariantDef,
} from "./receiving-profiles"

/**
 * Category profiles as data (zero-code categories, Phase 1).
 *
 * Every receiving profile lives in the `category_profiles` setting, an
 * array the operator edits from MBS Settings → Categories. Until that
 * setting is first saved, the built-in profiles in receiving-profiles.ts
 * are used unchanged, so deploying this changes nothing.
 *
 * Everything that needs a profile goes through here: the receiving
 * profile endpoint, receiving save, and the price-scope helper.
 */

export const CATEGORY_PROFILES_KEY = "category_profiles"

export type LoadedProfiles = {
  profiles: ReceivingProfile[]
  /** "settings" once the operator has saved the Categories tab. */
  source: "settings" | "built-in"
}

export async function loadProfiles(container: any): Promise<LoadedProfiles> {
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const raw = await settings.getSetting(CATEGORY_PROFILES_KEY).catch(() => null)
  if (!Array.isArray(raw) || raw.length === 0) {
    return { profiles: Object.values(PROFILES), source: "built-in" }
  }
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const profiles: ReceivingProfile[] = []
  for (const entry of raw) {
    const { profile, errors } = normalizeProfile(entry)
    /* Lists saved before price tables were configurable (Phase 2) carry
     * none; built-in profiles keep the tables they had. */
    if (profile && !profile.priceTables && PROFILES[profile.key]?.priceTables) {
      profile.priceTables = PROFILES[profile.key].priceTables
    }
    if (profile && entry?.shippingRatesKey === undefined && PROFILES[profile.key]?.shippingRatesKey) {
      profile.shippingRatesKey = PROFILES[profile.key].shippingRatesKey
    }
    if (profile) profiles.push(profile)
    else logger.warn(`[profile-store] skipping invalid category profile "${entry?.key ?? "?"}": ${errors.join("; ")}`)
  }
  return { profiles, source: "settings" }
}

/** The profile with this key, or null. Archived profiles are returned
 *  too; callers that receive stock check `archived` themselves. */
export async function findProfile(container: any, key: string): Promise<ReceivingProfile | null> {
  const { profiles } = await loadProfiles(container)
  return profiles.find((p) => p.key === key) ?? null
}

/* ─── Live subcategories ─── */

type Category = {
  id: string
  name: string
  handle: string
  parent_category_id?: string | null
  is_active?: boolean
  metadata?: any
}

export type ResolvedSubcategory = SubcategoryDef & {
  /** Medusa product_category id and handle. */
  id: string
  handle: string
  variants: VariantDef[]
}

export type ResolvedProfile = {
  /** The profile with `subcategories` replaced by the live list. */
  profile: Omit<ReceivingProfile, "subcategories"> & { subcategories: ResolvedSubcategory[] }
  parent: Category | null
  /** The category whose children are the subcategories. */
  enumRoot: Category | null
}

/**
 * Merge a profile with the categories that actually exist in Medusa.
 *
 * Live children of the profile's root drive the list. A profile entry
 * whose Medusa name matches keeps its key, label and sizes. A category
 * the profile doesn't mention is added only when it is active and has no
 * children of its own, so retired categories and intermediate levels
 * (Flower → CBD, the parent of the CBD tiers) stay out. It gets a slug
 * key, its own name, and sizes from `category.metadata.variants`, else
 * the profile's sizes, else a single "Unit". Profile entries with no
 * Medusa category are dropped.
 *
 * Receiving save uses the same list as the receiving page, so a
 * subcategory added in Medusa admin can be received, not just picked.
 */
export async function resolveProfileCategories(
  query: any,
  profile: ReceivingProfile,
): Promise<ResolvedProfile> {
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id", "is_active", "metadata"],
  })
  const cats = (data ?? []) as Category[]
  const hasChildren = new Set(cats.map((c) => c.parent_category_id).filter(Boolean))
  const parent = cats.find((c) => c.name === profile.parentCategoryName && !c.parent_category_id) ?? null
  const enumRoot = profile.subcategoryParentHandle
    ? cats.find((c) => c.handle === profile.subcategoryParentHandle) ?? null
    : parent
  if (!enumRoot) {
    return { profile: { ...profile, subcategories: [] }, parent, enumRoot: null }
  }

  const subcategories: ResolvedSubcategory[] = cats
    .filter((c) => c.parent_category_id === enumRoot.id)
    .filter((c) =>
      profile.subcategories.some((s) => s.medusaName === c.name) ||
      (c.is_active !== false && !hasChildren.has(c.id)),
    )
    .map((cat) => {
      const match = profile.subcategories.find((s) => s.medusaName === cat.name)
      if (match) {
        return {
          ...match,
          id: cat.id,
          handle: cat.handle,
          variants: match.variants && match.variants.length > 0 ? match.variants : profile.variants,
        }
      }
      const fromMeta = parseVariantsFromCategoryMetadata(cat.metadata)
      return {
        key: slugifyKey(cat.name),
        medusaName: cat.name,
        label: cat.name,
        id: cat.id,
        handle: cat.handle,
        variants: fromMeta ?? (profile.variants.length > 0 ? profile.variants : [DEFAULT_VARIANT]),
      }
    })

  return { profile: { ...profile, subcategories }, parent, enumRoot }
}

const DEFAULT_VARIANT: VariantDef = { sizeKey: "default", label: "Unit", multiplier: 1 }

export function slugifyKey(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "default"
}

/* Operator can set category.metadata.variants on a Medusa category to
 * give a new subcategory its own sizes. Shape:
 *   { variants: [{ sizeKey, label, multiplier, grams? }] }
 * Malformed entries are dropped. */
function parseVariantsFromCategoryMetadata(meta: any): VariantDef[] | null {
  const raw = meta?.variants
  if (!Array.isArray(raw) || raw.length === 0) return null
  const cleaned = raw.map((v) => normalizeVariant(v).variant).filter((v): v is VariantDef => !!v)
  return cleaned.length > 0 ? cleaned : null
}

/* ─── Validation ─── */

const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/* No hyphens: the QBO push finds a variant's base SKU by stripping the
 * last hyphen segment (qbo-api baseFromVariantSku), so the size has to
 * be one segment. */
const SIZE_KEY_RE = /^[a-z0-9]+$/
const SETTING_KEY_RE = /^[a-z0-9_]+$/

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const posNum = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeVariant(v: any): { variant: VariantDef | null; error?: string } {
  const sizeKey = str(v?.sizeKey)
  const label = str(v?.label)
  const multiplier = posNum(v?.multiplier)
  if (!SIZE_KEY_RE.test(sizeKey)) return { variant: null, error: `size key "${sizeKey}" must be lowercase letters/digits, no hyphens` }
  if (!label) return { variant: null, error: `size "${sizeKey}" needs a label` }
  if (multiplier == null) return { variant: null, error: `size "${sizeKey}" needs a stock multiplier above 0` }
  const out: VariantDef = { sizeKey, label, multiplier }
  const grams = posNum(v?.grams)
  if (grams != null) out.grams = grams
  const unitLabel = str(v?.unitLabel)
  if (unitLabel) out.unitLabel = unitLabel
  const units = posNum(v?.unitsPerVariant)
  if (units != null) out.unitsPerVariant = units
  return { variant: out }
}

function normalizeVariants(list: unknown, where: string, errors: string[]): VariantDef[] {
  if (list == null) return []
  if (!Array.isArray(list)) { errors.push(`${where}: sizes must be a list`); return [] }
  const out: VariantDef[] = []
  for (const v of list) {
    const { variant, error } = normalizeVariant(v)
    if (variant) out.push(variant)
    else errors.push(`${where}: ${error}`)
  }
  const seen = new Set<string>()
  for (const v of out) {
    if (seen.has(v.sizeKey)) errors.push(`${where}: size key "${v.sizeKey}" is used twice`)
    seen.add(v.sizeKey)
  }
  return out
}

function normalizeUnit(u: any, what: string, errors: string[]) {
  const singular = str(u?.singular)
  const plural = str(u?.plural)
  if (!singular || !plural) errors.push(`${what} needs a singular and plural`)
  return { singular, plural }
}

/** Validate and clean one profile. Returns the profile, or null with the
 *  reasons it was rejected. */
export function normalizeProfile(p: any): { profile: ReceivingProfile | null; errors: string[] } {
  const errors: string[] = []
  const key = str(p?.key)
  if (!KEY_RE.test(key)) errors.push(`key "${key}" must be lowercase words joined by hyphens`)
  const displayName = str(p?.displayName)
  if (!displayName) errors.push("display name is required")
  const parentCategoryName = str(p?.parentCategoryName)
  if (!parentCategoryName) errors.push("parent category is required")

  const subcategories: SubcategoryDef[] = []
  if (p?.subcategories != null && !Array.isArray(p.subcategories)) errors.push("subcategories must be a list")
  for (const s of Array.isArray(p?.subcategories) ? p.subcategories : []) {
    const sKey = str(s?.key)
    const medusaName = str(s?.medusaName)
    if (!KEY_RE.test(sKey)) { errors.push(`subcategory key "${sKey}" must be lowercase words joined by hyphens`); continue }
    if (!medusaName) { errors.push(`subcategory "${sKey}" needs its Medusa category name`); continue }
    const sub: SubcategoryDef = { key: sKey, medusaName, label: str(s?.label) || medusaName }
    const variants = normalizeVariants(s?.variants, `subcategory "${sKey}"`, errors)
    if (variants.length > 0) sub.variants = variants
    subcategories.push(sub)
  }
  for (const [i, s] of subcategories.entries()) {
    if (subcategories.findIndex((o) => o.key === s.key) !== i) errors.push(`subcategory key "${s.key}" is used twice`)
  }

  const variants = normalizeVariants(p?.variants, "sizes", errors)

  const pricingModel = str(p?.pricingModel) as PricingModel
  if (pricingModel !== "tier" && pricingModel !== "flat") errors.push(`pricing model must be "tier" or "flat"`)
  const tierPricesSettingKey = str(p?.tierPricesSettingKey)
  if (pricingModel === "tier" && !SETTING_KEY_RE.test(tierPricesSettingKey)) {
    errors.push("tier pricing needs a price table key (lowercase, underscores)")
  }

  const priceTables: PriceTables = {}
  for (const level of ["tier_2", "tier_3", "distro", "owner"] as const) {
    const k = str(p?.priceTables?.[level])
    if (!k) continue
    if (!SETTING_KEY_RE.test(k)) errors.push(`${level} price table "${k}" must be lowercase with underscores`)
    else priceTables[level] = k
  }

  const shippingRatesKey = str(p?.shippingRatesKey)
  if (shippingRatesKey && !SETTING_KEY_RE.test(shippingRatesKey)) {
    errors.push(`shipping rates bucket "${shippingRatesKey}" must be lowercase with underscores`)
  }

  const inputToPoolMultiplier = posNum(p?.inputToPoolMultiplier)
  if (inputToPoolMultiplier == null) errors.push("receiving unit multiplier must be above 0")

  const f = p?.fields ?? {}
  const profile: ReceivingProfile = {
    key,
    displayName,
    parentCategoryName,
    ...(str(p?.subcategoryParentHandle) ? { subcategoryParentHandle: str(p.subcategoryParentHandle) } : {}),
    subcategories,
    variants,
    fields: {
      strainType: !!f.strainType,
      bestFor: !!f.bestFor,
      effects: !!f.effects,
      cannabinoids: !!f.cannabinoids,
      coaRequired: !!f.coaRequired,
      upc: !!f.upc,
    },
    pricingModel,
    ...(tierPricesSettingKey ? { tierPricesSettingKey } : {}),
    unitLabel: normalizeUnit(p?.unitLabel, "stock unit", errors),
    inputUnitLabel: normalizeUnit(p?.inputUnitLabel, "receiving unit", errors),
    inputToPoolMultiplier: inputToPoolMultiplier ?? 1,
    ...(str(p?.qboCategoryBranch) ? { qboCategoryBranch: str(p.qboCategoryBranch) } : {}),
    ...(p?.archived ? { archived: true } : {}),
    /* Kept when sent, even empty, so clearing every table sticks; only
     * a missing field falls back to the built-in tables in loadProfiles. */
    ...(p?.priceTables && typeof p.priceTables === "object" ? { priceTables } : {}),
    ...(shippingRatesKey ? { shippingRatesKey } : {}),
  }
  return errors.length > 0 ? { profile: null, errors } : { profile, errors }
}

/** Validate a whole list: every profile plus unique keys. */
export function normalizeProfileList(list: unknown): { profiles: ReceivingProfile[]; errors: string[] } {
  if (!Array.isArray(list)) return { profiles: [], errors: ["profiles must be a list"] }
  const profiles: ReceivingProfile[] = []
  const errors: string[] = []
  for (const entry of list) {
    const { profile, errors: e } = normalizeProfile(entry)
    if (profile) profiles.push(profile)
    else errors.push(`${str(entry?.displayName) || str(entry?.key) || "unnamed"}: ${e.join("; ")}`)
  }
  for (const [i, p] of profiles.entries()) {
    if (profiles.findIndex((o) => o.key === p.key) !== i) errors.push(`category key "${p.key}" is used twice`)
  }
  return { profiles, errors }
}

import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { MBS_ATTRIBUTES_MODULE } from "../modules/mbs-attributes"
import { baseSku, generateSku } from "./sku"
import { FLOWER_PROFILE, getSubcategory, getVariantDef, getVariantsForRow, type ReceivingProfile } from "./receiving-profiles"

/**
 * Slice 2C — receiving save orchestrator.
 *
 * Each call to `saveOneRow()` either CREATES a new Medusa product (3
 * variants on a shared QP-pool inventory) or RESTOCKS an existing one
 * (increments the pool, refreshes attributes/COA). The route layer
 * loops over the payload's rows and aggregates per-row outcomes.
 *
 * Key design choices:
 * - **Pool inventory in QPs.** Single InventoryItem per strain. The 3
 *   variants link with required_quantity 1/2/4. One physical count.
 * - **Selling price from `flower_tier_prices` settings.** Variants get
 *   metadata `{ tier_linked: true, tier_key, size_key }` so a future
 *   subscriber (Slice 2E) can propagate Settings edits to all linked
 *   variants while leaving operator overrides alone.
 * - **Cost on the InventoryItem.** Medusa variants have no native
 *   `cost` field. Storing landed-cost-per-QP at the inventory level
 *   matches the spec — cost is per-strain, not per-variant.
 * - **Identity rule** (spec §3.7): `(strainName + tier)` → product.
 *   Handle = `<tier>-<strain-slug>` so the same strain in two tiers
 *   produces two distinct products.
 * - **Best-effort, per-row.** A single row's failure doesn't abort
 *   the whole receiving — error captured + returned, other rows
 *   continue.
 */

/* ---- Public types — match what the admin page sends ---- */

/**
 * One row in the receiving review grid → one product save attempt.
 *
 * Field naming notes (Slice R3/R4, 2026-05-14):
 *   - `quantity` is in the profile's INPUT unit (lb for flower, box for pre-roll).
 *     Multiplied by profile.inputToPoolMultiplier to get pool units (QPs for
 *     flower, boxes for pre-roll).
 *   - `unitPrice` is cost per input unit ($/lb for flower, $/box for pre-roll).
 *   - `sellPrice` only used when profile.pricingModel === "flat" (pre-rolls).
 *     For "tier" pricing (flower), variants get prices from the tier table.
 *   - `tier` is a misleading name for non-flower profiles — generically it's
 *     the subcategory key (classic/exotic/super/... for flower, thc-a/hashholes
 *     for pre-rolls). Kept as `tier` for now to avoid a huge rename cascade;
 *     internally treated as a subcategory key.
 */
export type SaveRow = {
  strainName: string
  quantity: number
  unitPrice: number
  sellPrice?: number
  tier: string
  strainType: "Indica" | "Sativa" | "Hybrid"
  bestFor: "day" | "evening" | "night"
  effects: string[]
  coaUrl: string | null
  coaOriginalName: string | null
  thcaPercent: string | null
  totalCannabinoidsPercent: string | null
  /** UPC barcode — only sent by profiles where fields.upc === true
   *  (Pre-Rolls and its subcategories). Lands on variant.barcode. */
  upc?: string | null
}

export type TierKey = "classic" | "exotic" | "super" | "snow" | "rapper"
export type SizeKey = "qp" | "half" | "lb"

export type TierPriceMap = Record<TierKey, { qp: number; half: number; lb: number }>

export type SaveRowResult = {
  strainName: string
  tier: string                               // subcategory key — preserved for QBO push
  /** Subcategory display label ("Super", "THC-A", "Hashholes", ...) —
   *  used by QBO push for human-readable Item names + line descriptions
   *  without each consumer needing a hardcoded label map. */
  tierLabel?: string
  /** Label of the multiplier-1 variant — the pool unit. "QP" for flower,
   *  "30 ct Box" / "15 ct Box" for pre-rolls. Used by QBO push for
   *  per-pool-unit phrasing on receiving Bill line descriptions. */
  poolUnitLabel?: string
  action: "created" | "restocked" | "failed"
  productId?: string
  productHandle?: string
  inventoryItemId?: string
  /** Base SKU (size-stripped) for this strain+subcategory. Used as QBO Item SKU.
   *  Variant SKUs append the size suffix. */
  baseSku?: string
  qtyQps: number                             // pool units (QPs for flower, boxes for pre-roll). Kept name for backward compat with the order push reader.
  landedPerQp: number                        // landed cost per pool unit. Kept name for backward compat.
  sellPrices: Record<string, number> | null  // keyed by variant sizeKey; null if pricing unavailable
  /** Pool units per operator-input unit. Flower=4 (4 QPs per lb received),
   *  Pre-Rolls=1 (1 box in = 1 box pool). QBO Item is tracked in INPUT
   *  units (lb for flower, box for pre-rolls), so push uses these to
   *  convert pool numbers back to operator-meaningful units on Bills. */
  inputToPoolMultiplier?: number
  /** Singular input-unit label ("lb", "box") for descriptions. */
  inputUnitLabel?: string
  /** Sell price per INPUT unit for the QBO Item's UnitPrice default.
   *  For flower: the LB-variant price. For pre-rolls: the only variant. */
  inputUnitSellPrice?: number
  /** Medusa category hierarchy [parent, leaf] — e.g. ["Flower", "Super"]
   *  or ["Pre-Rolls", "THC-A"]. QBO push uses this to nest the Item
   *  under matching Categories in QBO's Products & Services tree. */
  categoryPath?: string[]
  error?: string
}

/* Tier/size constants moved into FLOWER_PROFILE in receiving-profiles.ts.
 * The hardcoded TIER_CATEGORY_NAME / SIZE_LABELS / SIZE_QP_MULTIPLIER /
 * SIZE_GRAMS are now derived per-profile (Slice R2 of receiving
 * generalization, 2026-05-14). Other categories (Pre-Rolls etc.) layer
 * in via their own ReceivingProfile config. */

/* SKU generation moved to src/lib/sku.ts — single source of truth used
 * across receiving + manual product flows + the QBO Item push. */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
}

function asNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "string" ? Number(v) : v
  return Number.isFinite(n) ? n : null
}

/* ---- Shared invoice context for all rows in one save ---- */

export type ShippingWeights = {
  flower?: { qp?: number; half?: number; lb?: number }
  preroll?: Record<string, Record<string, number>>
}

export type SaveContext = {
  /** Active receiving profile — drives variant axes, subcategory lookups,
   *  pricing model, and field requirements. Defaults to FLOWER_PROFILE
   *  for backward compat; Pre-Rolls etc. pass their own. */
  profile: ReceivingProfile
  /** $/lb — total invoice shipping ÷ Σ(qty_lb). 0 if no shipping. */
  shipPerLb: number
  tierPrices: TierPriceMap
  /** Lb-based shipping weights (packaged) per variant size. Resolved once
   *  per save batch from `mbs_settings.shipping_weights`. Stamped onto
   *  each new variant's `metadata.shipping_weight_lb` so ShipStation can
   *  read it without touching the native variant.weight field (which
   *  carries net grams for the storefront's per-gram math). */
  shippingWeights: ShippingWeights | null
  /** Sales channel id to attach new products to (resolved once). */
  salesChannelId: string
  /** Stock location id to write inventory levels against (resolved once). */
  stockLocationId: string
  /** Map of subcategory-key → Medusa product_category id (resolved once).
   *  Keys are profile.subcategories[].key. Throws at build time if any
   *  configured subcategory is missing in the catalog. */
  subcategoryIds: Record<string, string>
  /** Default shipping profile id — required link or cart checkout fails. */
  shippingProfileId: string
}

/** Lookup helper: tier_key + size_key → packaged shipping weight in lb.
 *  Tier discriminates flower vs pre-roll subtree. Returns null when no
 *  matching entry — caller decides whether to throw or skip. */
export function lookupShippingWeight(
  weights: ShippingWeights | null,
  tierKey: string,
  sizeKey: string,
): number | null {
  if (!weights) return null
  if (tierKey === "classic" || tierKey === "exotic" || tierKey === "super" || tierKey === "snow" || tierKey === "rapper") {
    const w = (weights.flower as any)?.[sizeKey]
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null
  }
  const w = weights.preroll?.[tierKey]?.[sizeKey]
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null
}

export async function buildSaveContext(
  container: any,
  shipPerLb: number,
  tierPrices: TierPriceMap,
  shippingWeights: ShippingWeights | null,
  profile: ReceivingProfile = FLOWER_PROFILE,
): Promise<SaveContext> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL)
  const stockLocationService = container.resolve(Modules.STOCK_LOCATION)

  const [defaultChannel] = await salesChannelService.listSalesChannels({
    name: "Default Sales Channel",
  })
  if (!defaultChannel) {
    throw new Error("Default Sales Channel not found. Run `pnpm seed` first.")
  }

  const locations = await stockLocationService.listStockLocations({}, { take: 1 })
  if (!locations || locations.length === 0) {
    throw new Error("No stock location found. Run `pnpm seed` first.")
  }

  /* Look up each configured sub-category by name under the profile's
   * parent category. Mirror of seed-*-categories.ts shape — parent
   * row has no parent_category_id, children point to it via that id. */
  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })
  const parentCat = (allCats as any[]).find(
    (c) => c.name === profile.parentCategoryName && !c.parent_category_id,
  )
  if (!parentCat) {
    throw new Error(
      `"${profile.parentCategoryName}" parent category missing. Run the matching seed script (e.g. \`pnpm seed:flower-categories\` or \`pnpm seed:preroll-categories\`) to create the category tree.`,
    )
  }
  const subcategoryIds: Record<string, string> = {}
  for (const sub of profile.subcategories) {
    const cat = (allCats as any[]).find(
      (c) => c.name === sub.medusaName && c.parent_category_id === parentCat.id,
    )
    if (!cat) {
      throw new Error(
        `"${profile.parentCategoryName}" sub-category "${sub.medusaName}" missing. Run the matching seed script to create the category tree.`,
      )
    }
    subcategoryIds[sub.key] = cat.id
  }

  /* Default shipping profile — every product must link to one or
   * cart.complete() throws "shipping profiles not satisfied" at
   * checkout. Lazy-resolved here so we hit it once per save batch. */
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)
  const profiles = await fulfillmentService.listShippingProfiles({ type: "default" })
  const shippingProfile = profiles?.[0]
  if (!shippingProfile) {
    throw new Error("No default shipping profile found. Run `pnpm seed:us` first.")
  }

  return {
    profile,
    shipPerLb,
    tierPrices,
    shippingWeights,
    salesChannelId: defaultChannel.id,
    stockLocationId: locations[0].id,
    subcategoryIds,
    shippingProfileId: shippingProfile.id,
  }
}

/* ---- Per-row save: create-or-restock ---- */

export async function saveOneRow(
  container: any,
  row: SaveRow,
  ctx: SaveContext,
): Promise<SaveRowResult> {
  const strainSlug = slugify(row.strainName)
  /* Phase 5 — drop the legacy `${tier}-${strainSlug}` prefix so the
   * URL = handle 1:1 (`/products/<cat>/<sub>/<handle>`). Identity rule
   * is now strain-only — same strain across two tiers would collide
   * here, but in practice the operator commits to one tier per strain
   * at receive time (a strain is graded once, not stocked at multiple
   * tiers simultaneously). If a collision DOES happen, Medusa rejects
   * the create with a duplicate-handle error and the operator can
   * rename. */
  const handle = strainSlug
  /* Profile-aware pool math (Slice R3/R4, 2026-05-14):
   *   - row.quantity is in INPUT units (lb for flower, boxes for pre-roll).
   *   - ctx.shipPerLb is now profile-aware (shipping ÷ total input units),
   *     keeping the legacy field name for backward compat.
   *   - pool unit = INPUT × profile.inputToPoolMultiplier (4 for flower,
   *     1 for pre-rolls). The fields qtyQps/landedPerQp keep their names
   *     for backward compat with the QBO order push reader. */
  const inputToPool = ctx.profile.inputToPoolMultiplier
  const totalQps = Math.round((row.quantity || 0) * inputToPool)
  const landedPerInputUnit = (row.unitPrice || 0) + ctx.shipPerLb
  const landedPerQp = inputToPool > 0 ? landedPerInputUnit / inputToPool : landedPerInputUnit

  /* Variant prices: branch by profile.pricingModel. "tier" looks up in
   * ctx.tierPrices[subcategoryKey]. "flat" applies row.sellPrice to the
   * single variant. */
  let sellPrices: Record<string, number> | null = null
  let priceError: string | null = null
  if (ctx.profile.pricingModel === "tier") {
    const tp = ctx.tierPrices[row.tier as TierKey]
    if (!tp) {
      priceError = `No tier price configured for "${row.tier}".`
    } else {
      sellPrices = { qp: tp.qp, half: tp.half, lb: tp.lb }
    }
  } else {
    const sp = row.sellPrice
    if (!sp || sp <= 0) {
      priceError = `Sell price required for ${ctx.profile.displayName} row (per ${ctx.profile.inputUnitLabel.singular}).`
    } else {
      sellPrices = {}
      for (const v of getVariantsForRow(ctx.profile, row.tier)) {
        /* Single-variant categories (pre-rolls): all variants get the
         * same operator-typed sell price. Multi-variant flat-pricing
         * categories aren't supported yet — they'd need per-variant
         * price columns in the review grid. */
        sellPrices[v.sizeKey] = sp
      }
    }
  }

  /* Resolve display labels for the QBO push reader: subcategory label
   * (Super / THC-A / ...) + pool-unit label (QP / 30 ct Box / ...) +
   * input-unit metadata for LB-tracking QBO Items.
   * Best-effort — if a subcategory is missing from the profile (rare),
   * fall back to the raw key. */
  let tierLabel: string | undefined
  let poolUnitLabel: string | undefined
  /* Input-unit fields drive the QBO Item's UoM. For flower: 1 lb input
   * = 4 QPs pool, so QBO Item tracked in lb. For pre-rolls: 1 box in =
   * 1 box pool, no conversion needed. */
  const inputToPoolMultiplier = ctx.profile.inputToPoolMultiplier
  const inputUnitLabel = ctx.profile.inputUnitLabel?.singular
  let inputUnitSellPrice: number | undefined
  try {
    tierLabel = getSubcategory(ctx.profile, row.tier).label
  } catch {
    tierLabel = row.tier
  }
  try {
    const variants = getVariantsForRow(ctx.profile, row.tier)
    const poolUnit = variants.find((v) => v.multiplier === 1) ?? variants[0]
    poolUnitLabel = poolUnit?.label
    /* Find the variant whose multiplier matches inputToPoolMultiplier
     * (LB for flower, only-variant for pre-rolls) — its sellPrice is
     * what QBO's Item.UnitPrice should default to. */
    const inputVariant = variants.find((v) => v.multiplier === inputToPoolMultiplier) ?? poolUnit
    if (inputVariant && sellPrices) {
      inputUnitSellPrice = sellPrices[inputVariant.sizeKey]
    }
  } catch { /* leave optional fields undefined */ }

  /* Category hierarchy for QBO Category mirroring. Profile gives us the
   * parent name + subcategory medusaName. */
  let subcategoryMedusaName: string | undefined
  try {
    subcategoryMedusaName = getSubcategory(ctx.profile, row.tier).medusaName
  } catch { /* leave undefined */ }
  const categoryPath: string[] = subcategoryMedusaName
    ? [ctx.profile.parentCategoryName, subcategoryMedusaName]
    : [ctx.profile.parentCategoryName]

  const baseResult: SaveRowResult = {
    strainName: row.strainName,
    tier: row.tier,
    tierLabel,
    poolUnitLabel,
    action: "failed",
    qtyQps: totalQps,
    landedPerQp,
    sellPrices,
    inputToPoolMultiplier,
    inputUnitLabel,
    inputUnitSellPrice,
    categoryPath,
  }

  if (priceError) {
    return { ...baseResult, error: priceError }
  }
  if (!row.coaUrl) {
    return { ...baseResult, error: "COA URL is required to save (compliance)." }
  }
  /* Build a per-variant price map for the create path that supports
   * non-flower variant keys ("30pk" for pre-rolls). */
  const tp = sellPrices ?? {}

  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const inventoryService: any = container.resolve(Modules.INVENTORY)
    const mbsAttrs: any = container.resolve(MBS_ATTRIBUTES_MODULE)

    /* 1. Find existing product by handle (= identity rule). */
    const { data: existing } = await query.graph({
      entity: "product",
      fields: ["id", "handle", "variants.id", "variants.inventory_items.inventory.id", "product_attributes.id"],
      filters: { handle },
    })

    if (existing.length > 0) {
      /* ---------- RESTOCK PATH ---------- */
      const productId = existing[0].id
      const variants = (existing[0] as any).variants ?? []
      const firstInventoryId = variants[0]?.inventory_items?.[0]?.inventory?.id
      if (!firstInventoryId) {
        return { ...baseResult, error: "Existing product has no inventory item — schema mismatch." }
      }

      /* Increment the pool by adding to the existing level. We list
       * the current level for our location, then update its
       * stocked_quantity. */
      const [level] = await inventoryService.listInventoryLevels({
        inventory_item_id: firstInventoryId,
        location_id: ctx.stockLocationId,
      })
      if (level) {
        await inventoryService.updateInventoryLevels([{
          id: level.id,
          stocked_quantity: (level.stocked_quantity ?? 0) + totalQps,
        }])
      } else {
        await inventoryService.createInventoryLevels([{
          inventory_item_id: firstInventoryId,
          location_id: ctx.stockLocationId,
          stocked_quantity: totalQps,
        }])
      }

      /* Latest-COA-wins + refresh other attributes from this receiving. */
      const existingAttrsId = (existing[0] as any).product_attributes?.id
      const attrPayload = {
        strain_type: row.strainType,
        best_for: row.bestFor,
        effects: row.effects,
        thca_percent: row.thcaPercent,
        total_cannabinoids_percent: row.totalCannabinoidsPercent,
        coa_url: row.coaUrl,
      }
      if (existingAttrsId) {
        await mbsAttrs.updateProductAttributes({ id: existingAttrsId, ...attrPayload })
      } else {
        const newAttrs = await mbsAttrs.createProductAttributes(attrPayload)
        await link.create({
          [Modules.PRODUCT]: { product_id: productId },
          [MBS_ATTRIBUTES_MODULE]: { product_attributes_id: newAttrs.id },
        })
      }

      /* Update inventory item metadata with latest landed cost. */
      try {
        await inventoryService.updateInventoryItems([{
          id: firstInventoryId,
          metadata: { landed_per_qp: String(landedPerQp.toFixed(4)) },
        }])
      } catch { /* metadata write isn't critical for restock */ }

      return {
        ...baseResult,
        action: "restocked",
        productId,
        productHandle: handle,
        inventoryItemId: firstInventoryId,
        baseSku: baseSku({
          category: ctx.profile.parentCategoryName,
          subcategory: getSubcategory(ctx.profile, row.tier).medusaName,
          type: row.strainType,
          strain: row.strainName,
        }),
      }
    }

    /* ---------- CREATE PATH ---------- */

    /* SKU collision check — generated SKUs must be unique across products.
     * Same strain at the same subcategory is a restock (handled above), so any
     * variant we find with the same proposed SKU belonging to a DIFFERENT
     * product is a real collision (e.g. "Gold Rose Runtz" abbrevs the same
     * as "Gold Rose Runner"). Fail this row with a descriptive message;
     * the operator renames the strain and re-saves. */
    /* Per-subcategory variant resolution — Pre-Rolls THC-A uses
     * 30 ct boxes while Hashholes uses 15 ct boxes. Flower's tiers
     * all share the QP/Half/LB variants via profile.variants fallback. */
    const variantDefs = getVariantsForRow(ctx.profile, row.tier)
    const skuParts = {
      category: ctx.profile.parentCategoryName,
      subcategory: getSubcategory(ctx.profile, row.tier).medusaName,
      type: row.strainType,
      strain: row.strainName,
    }
    const proposedSkus = variantDefs.map((v) => generateSku({ ...skuParts, size: v.sizeKey }))
    const productService: any = container.resolve(Modules.PRODUCT)
    const conflicts = await productService.listProductVariants(
      { sku: proposedSkus },
      { take: 10, relations: ["product"] },
    )
    const realCollisions = (conflicts ?? []).filter((v: any) => v?.product?.handle !== handle)
    if (realCollisions.length > 0) {
      const desc = realCollisions
        .map((v: any) => `${v.sku} → ${v.product?.title ?? v.product?.handle ?? "unknown product"}`)
        .join("; ")
      return { ...baseResult, error: `SKU collision: ${desc}. Rename strain to avoid.` }
    }

    /* 1. Create the shared inventory item first so we can pass its
     *    id into all 3 variants via inventory_items[] in one workflow
     *    call. */
    const created = await inventoryService.createInventoryItems({
      sku: strainSlug,
      requires_shipping: true,
      title: row.strainName,
      metadata: { landed_per_qp: String(landedPerQp.toFixed(4)) },
    })
    const inventoryItemId = (Array.isArray(created) ? created[0] : created).id

    /* 2. Build variants on the shared inventory item — one per variant
     *    def in the profile. SKUs already computed above; reuse by idx. */
    const variants = variantDefs.map((v, idx) => ({
      title: v.label,
      sku: proposedSkus[idx],
      options: { Size: v.label },
      prices: [{ amount: tp[v.sizeKey] ?? 0, currency_code: "usd" }],
      manage_inventory: true,
      /* Weight in grams — required for the storefront margin calc to
       * render (cost/gram math). Also feeds ShipStation when wired.
       * Optional per profile — categories without a meaningful weight
       * (drinks etc.) leave this undefined. */
      ...(v.grams !== undefined ? { weight: v.grams } : {}),
      /* UPC → native Medusa variant.barcode field. Only set when the
       * profile enables UPC (pre-rolls today; flower leaves it null). */
      ...(ctx.profile.fields.upc && row.upc ? { barcode: row.upc } : {}),
      metadata: {
        tier_linked: true,
        tier_key: row.tier,
        size_key: v.sizeKey,
        /* Per-unit / margin-calc canonical override. Storefront's
         * src/lib/per-unit.ts hits these first (path #1) before falling
         * through to weight (path #2 — flower) or label regex (path #3).
         * For flower, omit — weight (113/227/454g) drives "g" / count
         * derivation. For pre-rolls and any future category that sets
         * them on the profile, write through. */
        ...(v.unitLabel ? { unit_label: v.unitLabel } : {}),
        ...(v.unitsPerVariant ? { units_per_variant: v.unitsPerVariant } : {}),
        /* Packaged shipping weight (lb) — read by ShipStation's rate
         * provider at checkout. Sits beside the native variant.weight
         * (grams, net flower content) because they're different
         * concepts; conflating them breaks the storefront's per-gram
         * pricing display. Skip the stamp silently when the setting
         * has no matching entry — operator can fill it in via MBS
         * Settings → Shipping Weights → Apply later. */
        ...(lookupShippingWeight(ctx.shippingWeights, row.tier, v.sizeKey) !== null
          ? { shipping_weight_lb: lookupShippingWeight(ctx.shippingWeights, row.tier, v.sizeKey)! }
          : {}),
      },
      inventory_items: [{
        inventory_item_id: inventoryItemId,
        required_quantity: v.multiplier,
      }],
    }))

    /* 3. Create the product with the variants in one workflow. */
    const { result: productResult } = await createProductsWorkflow(container).run({
      input: {
        products: [{
          title: row.strainName,
          handle,
          status: ProductStatus.PUBLISHED,
          category_ids: [ctx.subcategoryIds[row.tier]],
          options: [{ title: "Size", values: variantDefs.map((v) => v.label) }],
          variants,
          sales_channels: [{ id: ctx.salesChannelId }],
        }],
      },
    })
    const productId = productResult[0].id

    /* 4. Set initial pool stock at the location. createInventoryItems
     *    doesn't seed levels — we have to do it explicitly. */
    await inventoryService.createInventoryLevels([{
      inventory_item_id: inventoryItemId,
      location_id: ctx.stockLocationId,
      stocked_quantity: totalQps,
    }])

    /* 5. Write attributes via the mbs-attributes module + link. */
    const attrs = await mbsAttrs.createProductAttributes({
      strain_type: row.strainType,
      best_for: row.bestFor,
      effects: row.effects,
      thca_percent: row.thcaPercent,
      total_cannabinoids_percent: row.totalCannabinoidsPercent,
      coa_url: row.coaUrl,
    })
    await link.create({
      [Modules.PRODUCT]: { product_id: productId },
      [MBS_ATTRIBUTES_MODULE]: { product_attributes_id: attrs.id },
    })

    /* 6. Link product → default shipping profile. Without this,
     * cart.complete() throws "shipping profiles not satisfied" at
     * checkout. createProductsWorkflow doesn't auto-link this. */
    try {
      await link.create({
        [Modules.PRODUCT]: { product_id: productId },
        [Modules.FULFILLMENT]: { shipping_profile_id: ctx.shippingProfileId },
      })
    } catch (e: any) {
      /* Non-fatal — operator can run pnpm link:shipping-profile to
       * backfill if this happens. Log but don't fail the row. */
      console.warn(`[receiving:save] shipping profile link failed for ${row.strainName}: ${e?.message}`)
    }

    return {
      ...baseResult,
      action: "created",
      productId,
      productHandle: handle,
      inventoryItemId,
      baseSku: baseSku(skuParts),
    }
  } catch (e: any) {
    return { ...baseResult, error: e?.message ?? String(e) }
  }
}

/* Helper: shipping spread across input units (lb for flower, box for
 * pre-roll). Kept name `computeShipPerLb` for backward-compat with the
 * save route; semantically it's now "ship per input unit." */
export function computeShipPerLb(rows: { quantity: number }[], shippingTotal: number): number {
  const total = rows.reduce((s, r) => s + (r.quantity || 0), 0)
  if (total <= 0) return 0
  return shippingTotal / total
}

import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { MBS_ATTRIBUTES_MODULE } from "../modules/mbs-attributes"

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

export type SaveRow = {
  strainName: string
  quantityLb: number
  unitPricePerLb: number  // raw cost per lb from invoice (not landed)
  tier: TierKey
  strainType: "Indica" | "Sativa" | "Hybrid"
  bestFor: "day" | "evening" | "night"
  effects: string[]
  coaUrl: string | null
  coaOriginalName: string | null
  thcaPercent: string | null
  totalCannabinoidsPercent: string | null
}

export type TierKey = "classic" | "exotic" | "super" | "snow" | "rapper"
export type SizeKey = "qp" | "half" | "lb"

export type TierPriceMap = Record<TierKey, { qp: number; half: number; lb: number }>

export type SaveRowResult = {
  strainName: string
  action: "created" | "restocked" | "failed"
  productId?: string
  productHandle?: string
  inventoryItemId?: string
  qtyQps: number
  landedPerQp: number
  sellPrices: { qp: number; half: number; lb: number } | null
  error?: string
}

/* ---- Tier → category-name mapping (matches seed-mbs.ts).
 * `snow` is "Snowcaps" (legacy label) — everywhere else uses the
 * key, but the existing category was already named Snowcaps so we
 * preserve it to avoid creating a duplicate. */
const TIER_CATEGORY_NAME: Record<TierKey, string> = {
  classic: "Classic",
  exotic:  "Exotic",
  super:   "Super",
  snow:    "Snowcaps",
  rapper:  "Rapper",
}

/* Size option values for variants created via receiving. Short forms
 * since the storefront now displays operator-typed values verbatim
 * (Path A of dynamic-catalog rebuild — no automatic transforms).
 * Operator can rename these per-variant in admin if they prefer
 * different copy. */
const SIZE_LABELS: Record<SizeKey, string> = {
  qp:   "QP",
  half: "½",
  lb:   "LB",
}

/* QPs per size — used for both required_quantity (variant link) and
 * the pool stocked_quantity. 1 lb = 4 QPs. */
const SIZE_QP_MULTIPLIER: Record<SizeKey, number> = {
  qp: 1, half: 2, lb: 4,
}

/* Variant weight in grams. Drives the storefront margin calc (cost/g)
 * and ShipStation's box weight when wired. 1 lb ≈ 453.6g; we round to
 * whole grams since fractional grams aren't worth the precision. */
const SIZE_GRAMS: Record<SizeKey, number> = {
  qp: 113, half: 227, lb: 454,
}

/* SKU pattern from feedback memory (locked 2026-04-25):
 *   <size>-<subcat>-<type>-<strain>  (lowercase, hyphenated)
 * For Flower receiving: subcat=flower, type=indica/sativa/hybrid. */
function sku(size: SizeKey, strainType: string, strainSlug: string): string {
  return `${size}-flower-${strainType.toLowerCase()}-${strainSlug}`
}

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

export type SaveContext = {
  /** $/lb — total invoice shipping ÷ Σ(qty_lb). 0 if no shipping. */
  shipPerLb: number
  tierPrices: TierPriceMap
  /** Sales channel id to attach new products to (resolved once). */
  salesChannelId: string
  /** Stock location id to write inventory levels against (resolved once). */
  stockLocationId: string
  /** Map of tier → flower-sub-category-id (resolved once). Throws if missing. */
  tierCategoryIds: Record<TierKey, string>
  /** Default shipping profile id — required link or cart checkout fails. */
  shippingProfileId: string
}

export async function buildSaveContext(
  container: any,
  shipPerLb: number,
  tierPrices: TierPriceMap,
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

  /* Look up each Flower sub-category by name under the Flower parent.
   * Mirror of seed-mbs.ts ensureCategoryTree shape. */
  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })
  const flowerParent = (allCats as any[]).find((c) => c.name === "Flower" && !c.parent_category_id)
  if (!flowerParent) {
    throw new Error("Flower parent category missing. Run `pnpm seed:mbs` to create the category tree.")
  }
  const tierCategoryIds: Record<string, string> = {}
  for (const [tierKey, catName] of Object.entries(TIER_CATEGORY_NAME)) {
    const cat = (allCats as any[]).find(
      (c) => c.name === catName && c.parent_category_id === flowerParent.id,
    )
    if (!cat) {
      throw new Error(`Flower sub-category "${catName}" missing. Run \`pnpm seed:mbs\` to create the category tree.`)
    }
    tierCategoryIds[tierKey] = cat.id
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
    shipPerLb,
    tierPrices,
    salesChannelId: defaultChannel.id,
    stockLocationId: locations[0].id,
    tierCategoryIds: tierCategoryIds as Record<TierKey, string>,
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
  const handle = `${row.tier}-${strainSlug}`
  const totalQps = Math.round(row.quantityLb * 4)
  const landedPerLb = (row.unitPricePerLb || 0) + ctx.shipPerLb
  const landedPerQp = landedPerLb / 4
  const tp = ctx.tierPrices[row.tier]

  const baseResult: SaveRowResult = {
    strainName: row.strainName,
    action: "failed",
    qtyQps: totalQps,
    landedPerQp,
    sellPrices: tp ? { qp: tp.qp, half: tp.half, lb: tp.lb } : null,
  }

  if (!tp) {
    return { ...baseResult, error: `No tier price configured for "${row.tier}".` }
  }
  if (!row.coaUrl) {
    return { ...baseResult, error: "COA URL is required to save (compliance)." }
  }

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
      }
    }

    /* ---------- CREATE PATH ---------- */

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

    /* 2. Build the 3 variants on the shared inventory item. */
    const sizes: SizeKey[] = ["qp", "half", "lb"]
    const variants = sizes.map((size) => ({
      title: SIZE_LABELS[size],
      sku: sku(size, row.strainType, strainSlug),
      options: { Size: SIZE_LABELS[size] },
      prices: [{ amount: tp[size], currency_code: "usd" }],
      manage_inventory: true,
      /* Weight in grams — required for the storefront margin calc to
       * render (cost/gram math). Also feeds ShipStation when wired. */
      weight: SIZE_GRAMS[size],
      metadata: {
        tier_linked: true,
        tier_key: row.tier,
        size_key: size,
      },
      inventory_items: [{
        inventory_item_id: inventoryItemId,
        required_quantity: SIZE_QP_MULTIPLIER[size],
      }],
    }))

    /* 3. Create the product with the 3 variants in one workflow. */
    const { result: productResult } = await createProductsWorkflow(container).run({
      input: {
        products: [{
          title: row.strainName,
          handle,
          status: ProductStatus.PUBLISHED,
          category_ids: [ctx.tierCategoryIds[row.tier]],
          options: [{ title: "Size", values: sizes.map((s) => SIZE_LABELS[s]) }],
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
    }
  } catch (e: any) {
    return { ...baseResult, error: e?.message ?? String(e) }
  }
}

/* Helper: shipping spread — same calc as the admin page. */
export function computeShipPerLb(rows: { quantityLb: number }[], shippingTotal: number): number {
  const totalLb = rows.reduce((s, r) => s + (r.quantityLb || 0), 0)
  if (totalLb <= 0) return 0
  return shippingTotal / totalLb
}

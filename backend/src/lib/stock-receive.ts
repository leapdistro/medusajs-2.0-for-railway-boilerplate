import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import { batchVariantImagesWorkflow, createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { baseSku as skuBase } from "./sku"
import { brandCollectionId, type SaveRowResult } from "./receiving-save"
import { resolveProfileCategories } from "./profile-store"
import { rateForProfile, type ShippingRates } from "./shipping-rates"
import type { ReceivingProfile } from "./receiving-profiles"

/**
 * Receive stock (owner, 2026-11-14, modelled on Lightspeed X-Series):
 * the receiving for resold brands (categories with the Brand field on).
 *
 * Everything is counted in boxes. A product is sold by the box, and
 * optionally by the case of N boxes, which uses N boxes of the same
 * stock. A product can have up to three options (Flavour, Colour,
 * Size…); each combination is an "item" with its own UPC, stock
 * (one inventory item, in boxes), cost and photos. So an item has a box
 * variant (required_quantity 1) and maybe a case variant
 * (required_quantity N) on the same inventory item.
 *
 * Unlike the category receiving (receiving-save.ts), sizes come from the
 * product, not the category: RAW papers are 50 to a box, Zig-Zag 24,
 * and case counts vary by product.
 *
 * Each item writes one receiving-history line in the shape the rest of
 * the system reads (QuickBooks bill, Analytics FIFO, inventory value,
 * Product Photos): qtyQps = boxes, landedPerQp = landed cost per box,
 * inputToPoolMultiplier 1 (QuickBooks tracks boxes).
 */

/** The option the box / case choice is saved under. */
export const PACK_OPTION = "Pack"
export const MAX_OPTIONS = 3

export type RestockIn = {
  /** The item's inventory item (one flavour of one product). */
  inventoryItemId: string
  qty: number
  /** Cost per box before freight. */
  cost: number
  /** New default box / case price; null or absent keeps the current one. */
  boxPrice?: number | null
  casePrice?: number | null
}

export type NewItemIn = {
  /** Option title → value, e.g. { Flavour: "Grape" }. Empty when the
   *  product has no options. */
  values: Record<string, string>
  upc?: string | null
  qty: number
  cost: number
  boxPrice: number
  casePrice?: number | null
  /** Uploaded photo URLs (POST /admin/uploads) for this item only. */
  imageUrls?: string[]
}

export type NewProductIn = {
  title: string
  brand?: string | null
  /** Medusa category the product goes in (a sub-category of the profile). */
  categoryId: string
  description?: string | null
  /** "Box of <unitCount> <unitName>". */
  unitCount: number
  unitName: string
  /** Boxes per case; null or absent when it isn't sold by the case. */
  perCase?: number | null
  options: Array<{ title: string; values: string[] }>
  items: NewItemIn[]
  /** Photos for every item (the box shot, say). */
  imageUrls?: string[]
}

export type StockLineResult = SaveRowResult & {
  /** Cost per box before freight, and the box / case prices after. */
  cost?: number
  boxPrice?: number | null
  casePrice?: number | null
  /** Box price before this receiving (restock), for the price history. */
  boxPriceBefore?: number | null
  upc?: string | null
  /** A step after the stock went in that didn't work (photos, a price).
   *  Not `error`: a line with an error is left out of Analytics' FIFO
   *  layers and reads as failed. */
  warning?: string
}

export type StockContext = {
  profile: ReceivingProfile
  /** Sub-categories the profile receives into: id → { name, handle }. */
  categories: Map<string, { name: string; handle: string; key: string }>
  parentName: string
  salesChannelId: string
  stockLocationId: string
  shippingProfileId: string
  shippingRates: ShippingRates | null
  /** Landed cost per box = cost × this (freight split by value). */
  freightFactor: number
  brandIds?: Map<string, Promise<string>>
}

const round2 = (n: number) => Math.round(n * 100) / 100
const clean = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ")
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)

/** "Box of 25" / "Case of 12 boxes" — the Pack option values. */
export const boxLabel = (count: number) => `Box of ${count}`
export const caseLabel = (perCase: number) => `Case of ${perCase} boxes`

/** "Zig-Zag Hemp Wraps · Grape" — an item's name on bills and history. */
export const itemName = (title: string, values: Record<string, string>) => {
  const v = Object.values(values).map(clean).filter(Boolean)
  return v.length ? `${clean(title)} · ${v.join(" / ")}` : clean(title)
}

/** Freight spread over the goods by value: landed = cost × factor. */
export function freightFactor(goods: number, freight: number): number {
  return goods > 0 && freight > 0 ? 1 + freight / goods : 1
}

export async function buildStockContext(
  container: any,
  profile: ReceivingProfile,
  freight: number,
  goods: number,
  shippingRates: ShippingRates | null,
): Promise<StockContext> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const resolved = await resolveProfileCategories(query, profile)
  if (!resolved.enumRoot) {
    throw new Error(`"${profile.parentCategoryName}" category missing in Medusa. Create it, or fix MBS Settings → Categories.`)
  }
  const categories = new Map<string, { name: string; handle: string; key: string }>()
  for (const s of resolved.profile.subcategories) categories.set(s.id, { name: s.medusaName, handle: s.handle, key: s.key })

  const [channel] = await container.resolve(Modules.SALES_CHANNEL).listSalesChannels({ name: "Default Sales Channel" })
  if (!channel) throw new Error("Default Sales Channel not found.")
  const [location] = await container.resolve(Modules.STOCK_LOCATION).listStockLocations({}, { take: 1 })
  if (!location) throw new Error("No stock location found.")
  const [shippingProfile] = await container.resolve(Modules.FULFILLMENT).listShippingProfiles({ type: "default" })
  if (!shippingProfile) throw new Error("No default shipping profile found.")

  return {
    profile: resolved.profile,
    categories,
    parentName: resolved.parent?.name ?? profile.parentCategoryName,
    salesChannelId: channel.id,
    stockLocationId: location.id,
    shippingProfileId: shippingProfile.id,
    shippingRates,
    freightFactor: freightFactor(goods, freight),
  }
}

/* ---------- Restock ---------- */

type VariantRow = {
  id: string
  title?: string
  metadata?: Record<string, any> | null
  options?: Array<{ value?: string; option?: { title?: string } }>
  price_set?: { prices?: Array<{ id: string; amount: any; currency_code?: string; price_list_id?: string | null }> }
  inventory_items?: Array<{ required_quantity?: number; inventory?: { id?: string; sku?: string } }>
  product?: { id: string; title: string; handle: string; categories?: Array<{ id: string }> }
}

/** An inventory item's product and its box / case variants. */
export type CatalogItem = {
  inventoryItemId: string
  sku: string
  productId: string
  productTitle: string
  productHandle: string
  categoryId: string | null
  values: Record<string, string>
  box: { variantId: string; priceId: string | null; price: number | null } | null
  case: { variantId: string; priceId: string | null; price: number | null; perCase: number } | null
}

const amountOf = (a: any) => Number(a?.value ?? a?.numeric ?? a)

/** The default USD price row of a variant (not a price-list price). */
function defaultPrice(v: VariantRow): { id: string; amount: number } | null {
  const p = (v.price_set?.prices ?? []).find((x) => x.currency_code === "usd" && !x.price_list_id)
  return p ? { id: p.id, amount: amountOf(p.amount) } : null
}

/** Items (inventory items) of the given ids, with their variants. */
export async function loadItems(container: any, inventoryItemIds: string[]): Promise<Map<string, CatalogItem>> {
  const out = new Map<string, CatalogItem>()
  if (inventoryItemIds.length === 0) return out
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const { rows } = await pg.raw(
    `select variant_id from product_variant_inventory_item where inventory_item_id = any(?) and deleted_at is null`,
    [inventoryItemIds],
  )
  const variantIds = [...new Set((rows as any[]).map((l) => String(l.variant_id)))]
  if (variantIds.length === 0) return out
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "metadata", "options.value", "options.option.title",
      "price_set.prices.id", "price_set.prices.amount", "price_set.prices.currency_code", "price_set.prices.price_list_id",
      "inventory_items.required_quantity", "inventory_items.inventory.id", "inventory_items.inventory.sku",
      "product.id", "product.title", "product.handle", "product.categories.id",
    ],
    filters: { id: variantIds, deleted_at: null },
  })
  for (const v of variants as VariantRow[]) {
    const link = (v.inventory_items ?? [])[0]
    const invId = link?.inventory?.id
    if (!invId || !v.product) continue
    const units = Number(link?.required_quantity) || 1
    const item = out.get(invId) ?? {
      inventoryItemId: invId,
      sku: String(link?.inventory?.sku ?? ""),
      productId: v.product.id,
      productTitle: v.product.title,
      productHandle: v.product.handle,
      categoryId: v.product.categories?.[0]?.id ?? null,
      values: {},
      box: null,
      case: null,
    }
    const values: Record<string, string> = {}
    for (const o of v.options ?? []) {
      const t = o.option?.title
      if (t && t !== PACK_OPTION && o.value) values[t] = o.value
    }
    if (Object.keys(values).length > Object.keys(item.values).length) item.values = values
    const price = defaultPrice(v)
    if (units === 1 && !item.box) item.box = { variantId: v.id, priceId: price?.id ?? null, price: price?.amount ?? null }
    else if (units > 1 && !item.case) item.case = { variantId: v.id, priceId: price?.id ?? null, price: price?.amount ?? null, perCase: units }
    out.set(invId, item)
  }
  return out
}

export async function restockItem(
  container: any,
  line: RestockIn,
  item: CatalogItem,
  ctx: StockContext,
): Promise<StockLineResult> {
  const category = item.categoryId ? ctx.categories.get(item.categoryId) : undefined
  const landed = round2(line.cost * ctx.freightFactor * 10000) / 10000
  const base: StockLineResult = {
    ...lineBase(ctx, itemName(item.productTitle, item.values), category, line.qty, landed),
    productId: item.productId,
    productHandle: item.productHandle,
    inventoryItemId: item.inventoryItemId,
    baseSku: item.sku,
    cost: line.cost,
    boxPriceBefore: item.box?.price ?? null,
    boxPrice: line.boxPrice ?? item.box?.price ?? null,
    casePrice: line.casePrice ?? item.case?.price ?? null,
    sellPrices: prices(line.boxPrice ?? item.box?.price ?? null, line.casePrice ?? item.case?.price ?? null),
    inputUnitSellPrice: line.boxPrice ?? item.box?.price ?? undefined,
  }
  const inventory: any = container.resolve(Modules.INVENTORY)
  try {
    const [level] = await inventory.listInventoryLevels({ inventory_item_id: item.inventoryItemId, location_id: ctx.stockLocationId })
    if (level) {
      await inventory.updateInventoryLevels([{
        inventory_item_id: item.inventoryItemId,
        location_id: ctx.stockLocationId,
        stocked_quantity: (level.stocked_quantity ?? 0) + line.qty,
      }])
    } else {
      await inventory.createInventoryLevels([{ inventory_item_id: item.inventoryItemId, location_id: ctx.stockLocationId, stocked_quantity: line.qty }])
    }
  } catch (e: any) {
    return { ...base, error: `Stock for "${base.strainName}" couldn't be added: ${e?.message ?? e}` }
  }

  /* The stock is in from here on; a later step failing is reported but
   * the line counts as restocked so saving again doesn't add it twice. */
  const notes: string[] = []
  if (landed > 0) {
    await inventory.updateInventoryItems([{ id: item.inventoryItemId, metadata: { landed_per_qp: landed.toFixed(4) } }])
      .catch((e: any) => notes.push(`cost not saved (${e?.message ?? e})`))
  }
  const pricing: any = container.resolve(Modules.PRICING)
  const updates: Array<{ id: string; amount: number }> = []
  if (line.boxPrice && item.box?.priceId && line.boxPrice !== item.box.price) updates.push({ id: item.box.priceId, amount: line.boxPrice })
  if (line.casePrice && item.case?.priceId && line.casePrice !== item.case.price) updates.push({ id: item.case.priceId, amount: line.casePrice })
  if (updates.length) await pricing.updatePrices(updates).catch((e: any) => notes.push(`price not saved (${e?.message ?? e})`))

  return { ...base, action: "restocked", ...(notes.length ? { warning: notes.join("; ") } : {}) }
}

/* ---------- New product ---------- */

const prices = (box: number | null | undefined, kase: number | null | undefined) => {
  const out: Record<string, number> = {}
  if (box) out.box = box
  if (kase) out.case = kase
  return Object.keys(out).length ? out : null
}

function lineBase(
  ctx: StockContext,
  name: string,
  category: { name: string; handle: string; key: string } | undefined,
  qty: number,
  landed: number,
): StockLineResult {
  return {
    strainName: name,
    tier: category?.handle ?? "",
    tierLabel: category?.name,
    poolUnitLabel: "Box",
    action: "failed",
    qtyQps: qty,
    landedPerQp: landed,
    sellPrices: null,
    inputToPoolMultiplier: 1,
    inputUnitLabel: "box",
    categoryPath: category ? [ctx.parentName, category.name] : [ctx.parentName],
  }
}

/** Problems with a new product that stop the receiving before any write. */
export function checkNewProduct(p: NewProductIn, ctx: StockContext): string | null {
  const title = clean(p.title)
  if (!title) return "A new product has no name."
  if (!ctx.categories.has(p.categoryId)) return `"${title}": pick a ${ctx.profile.displayName} sub-category.`
  if (!(p.unitCount > 0) || !Number.isInteger(p.unitCount)) return `"${title}": how many ${p.unitName || "pieces"} are in a box?`
  if (p.perCase != null && !(Number.isInteger(p.perCase) && p.perCase > 1)) return `"${title}": a case needs 2 or more boxes.`
  if (p.options.length > MAX_OPTIONS) return `"${title}": up to ${MAX_OPTIONS} options.`
  const titles = p.options.map((o) => clean(o.title))
  if (titles.some((t) => !t) || new Set(titles.map((t) => t.toLowerCase())).size !== titles.length) return `"${title}": each option needs its own name.`
  if (titles.some((t) => t.toLowerCase() === PACK_OPTION.toLowerCase())) {
    return `"${title}": "${PACK_OPTION}" is used for box / case; call the option something else.`
  }
  if (p.items.length === 0) return `"${title}" has no lines.`
  const seen = new Set<string>()
  for (const it of p.items) {
    for (const t of titles) if (!clean(it.values[t])) return `"${title}": a line has no ${t}.`
    const k = titles.map((t) => clean(it.values[t]).toLowerCase()).join("|")
    if (seen.has(k)) return `"${title}": ${itemName(title, it.values)} is listed twice. Combine the lines.`
    seen.add(k)
    if (!(it.qty > 0)) return `"${itemName(title, it.values)}": enter how many boxes came in.`
    if (!(it.boxPrice > 0)) return `"${itemName(title, it.values)}": enter the box price.`
  }
  return null
}

/** A base SKU no product or inventory item uses yet. */
async function freeBaseSku(container: any, wanted: string, taken: Set<string>): Promise<string> {
  const productModule: any = container.resolve(Modules.PRODUCT)
  const inventory: any = container.resolve(Modules.INVENTORY)
  for (let n = 1; n < 50; n += 1) {
    const sku = n === 1 ? wanted : `${wanted}-${n}`
    if (taken.has(sku)) continue
    const [variants, items] = await Promise.all([
      productModule.listProductVariants({ sku: [`${sku}-box`, `${sku}-case`] }, { take: 1, select: ["id"] }),
      inventory.listInventoryItems({ sku }, { take: 1, select: ["id"] }),
    ])
    if (variants.length === 0 && items.length === 0) {
      taken.add(sku)
      return sku
    }
  }
  throw new Error(`no free SKU near ${wanted}`)
}

async function freeHandle(container: any, wanted: string): Promise<string> {
  const productModule: any = container.resolve(Modules.PRODUCT)
  for (let n = 1; n < 50; n += 1) {
    const handle = n === 1 ? wanted : `${wanted}-${n}`
    const found = await productModule.listProducts({ handle }, { take: 1, select: ["id"], withDeleted: true })
    if (found.length === 0) return handle
  }
  throw new Error(`no free handle near ${wanted}`)
}

/**
 * Creates the product with every item, its stock and photos. Returns one
 * result per item, in order. Nothing is written if the product can't be
 * created; a photo step failing afterwards is noted on the lines.
 */
export async function createProduct(
  container: any,
  p: NewProductIn,
  ctx: StockContext,
  takenSkus: Set<string>,
): Promise<StockLineResult[]> {
  const title = clean(p.title)
  const category = ctx.categories.get(p.categoryId)!
  const perCase = p.perCase && p.perCase > 1 ? p.perCase : null
  const optionTitles = p.options.map((o) => clean(o.title))
  const unitName = clean(p.unitName) || "pieces"
  const boxValue = boxLabel(p.unitCount)
  const caseValue = perCase ? caseLabel(perCase) : null

  const results: StockLineResult[] = p.items.map((it) => ({
    ...lineBase(ctx, itemName(title, it.values), category, it.qty, round2(it.cost * ctx.freightFactor * 10000) / 10000),
    cost: it.cost,
    boxPrice: it.boxPrice,
    casePrice: caseValue ? it.casePrice ?? round2(it.boxPrice * perCase!) : null,
    sellPrices: prices(it.boxPrice, caseValue ? it.casePrice ?? round2(it.boxPrice * perCase!) : null),
    inputUnitSellPrice: it.boxPrice,
    upc: clean(it.upc) || null,
  }))
  const fail = (error: string) => results.map((r) => ({ ...r, error }))

  let brandId: string | null = null
  if (clean(p.brand)) {
    try {
      brandId = await brandCollectionId(container, ctx, clean(p.brand))
    } catch (e: any) {
      return fail(`Couldn't find or create the brand "${clean(p.brand)}": ${e?.message ?? e}`)
    }
  }

  const inventory: any = container.resolve(Modules.INVENTORY)
  let handle: string
  const skus: string[] = []
  try {
    handle = await freeHandle(container, slugify(title))
    for (const it of p.items) {
      const wanted = skuBase({
        category: ctx.parentName,
        subcategory: category.name,
        strain: [title, ...optionTitles.map((t) => it.values[t])].join(" "),
      })
      skus.push(await freeBaseSku(container, wanted, takenSkus))
    }
  } catch (e: any) {
    return fail(`"${title}": ${e?.message ?? e}`)
  }

  /* One inventory item (box stock) per item. */
  const inventoryIds: string[] = []
  try {
    for (let i = 0; i < p.items.length; i += 1) {
      const created = await inventory.createInventoryItems({
        sku: skus[i],
        requires_shipping: true,
        title: results[i].strainName,
        metadata: { landed_per_qp: results[i].landedPerQp.toFixed(4) },
      })
      const id = (Array.isArray(created) ? created[0] : created)?.id
      if (!id) throw new Error("the stock item wasn't created")
      inventoryIds.push(id)
    }
  } catch (e: any) {
    if (inventoryIds.length) await inventory.deleteInventoryItems(inventoryIds).catch(() => {})
    return fail(`"${title}": ${e?.message ?? e}`)
  }

  const rate = (sizeKey: string) => {
    const dollars = rateForProfile(ctx.shippingRates, ctx.profile, category.key, sizeKey)
    return dollars != null ? { weight: Math.round(dollars * 100), dollars } : null
  }
  const variantFor = (it: NewItemIn, i: number, kind: "box" | "case") => {
    const units = kind === "box" ? 1 : perCase!
    const shipping = rate(kind)
    const options: Record<string, string> = { [PACK_OPTION]: kind === "box" ? boxValue : caseValue! }
    for (const t of optionTitles) options[t] = clean(it.values[t])
    const named = optionTitles.map((t) => clean(it.values[t]))
    return {
      title: [...named, options[PACK_OPTION]].join(" / "),
      sku: `${skus[i]}-${kind}`,
      options,
      prices: [{ amount: kind === "box" ? it.boxPrice : results[i].casePrice!, currency_code: "usd" }],
      manage_inventory: true,
      ...(kind === "box" && clean(it.upc) ? { barcode: clean(it.upc) } : {}),
      ...(shipping ? { weight: shipping.weight } : {}),
      metadata: {
        size_key: kind,
        profile_key: ctx.profile.key,
        input_to_pool: 1,
        /* Boxes this size uses (Owner Stores prices: cost × pool_units). */
        pool_units: units,
        pieces_per_box: p.unitCount,
        piece_name: unitName,
        /* The store prices these per box (owner: "we sell the box, not
         * individual cones"): a case shows its price a box and its saving. */
        unit_label: "box",
        units_per_variant: units,
        ...(shipping ? { shipping_rate_usd: shipping.dollars } : {}),
      },
      inventory_items: [{ inventory_item_id: inventoryIds[i], required_quantity: units }],
    }
  }
  const variants = p.items.flatMap((it, i) => [
    variantFor(it, i, "box"),
    ...(caseValue ? [variantFor(it, i, "case")] : []),
  ])

  const allUrls = [...(p.imageUrls ?? []), ...p.items.flatMap((it) => it.imageUrls ?? [])].filter(Boolean)
  const uniqueUrls = [...new Set(allUrls)]
  let productId: string
  try {
    const { result } = await createProductsWorkflow(container).run({
      input: {
        products: [{
          title,
          handle,
          ...(clean(p.description) ? { description: String(p.description).trim() } : {}),
          status: ProductStatus.PUBLISHED,
          category_ids: [p.categoryId],
          ...(brandId ? { collection_id: brandId } : {}),
          options: [
            ...p.options.map((o) => ({ title: clean(o.title), values: [...new Set(p.items.map((it) => clean(it.values[clean(o.title)])))] })),
            { title: PACK_OPTION, values: caseValue ? [boxValue, caseValue] : [boxValue] },
          ],
          variants,
          ...(uniqueUrls.length ? { images: uniqueUrls.map((url) => ({ url })), thumbnail: uniqueUrls[0] } : {}),
          sales_channels: [{ id: ctx.salesChannelId }],
        }],
      },
    })
    productId = result[0].id
  } catch (e: any) {
    await inventory.deleteInventoryItems(inventoryIds).catch(() => {})
    return fail(`"${title}" couldn't be created: ${e?.message ?? e}`)
  }

  const notes: string[] = []
  try {
    await inventory.createInventoryLevels(p.items.map((it, i) => ({
      inventory_item_id: inventoryIds[i],
      location_id: ctx.stockLocationId,
      stocked_quantity: it.qty,
    })))
  } catch (e: any) {
    /* The product exists without stock: say so on every line rather than
     * pretend it was received. */
    return results.map((r, i) => ({
      ...r, productId, productHandle: handle, inventoryItemId: inventoryIds[i], baseSku: skus[i],
      error: `"${title}" was created but its stock wasn't added (${e?.message ?? e}). Add the boxes in Medusa admin → Inventory.`,
    }))
  }

  const link = container.resolve(ContainerRegistrationKeys.LINK)
  await link.create({
    [Modules.PRODUCT]: { product_id: productId },
    [Modules.FULFILLMENT]: { shipping_profile_id: ctx.shippingProfileId },
  }).catch((e: any) => notes.push(`shipping profile not linked (${e?.message ?? e})`))

  /* Each item's own photos go on its box and case. */
  if (p.items.some((it) => it.imageUrls?.length)) {
    try {
      await linkItemImages(container, productId, p.items.map((it, i) => ({
        inventoryItemId: inventoryIds[i],
        urls: it.imageUrls ?? [],
      })))
    } catch (e: any) {
      notes.push(`photos not linked to their ${optionTitles[0] ?? "item"} (${e?.message ?? e})`)
    }
  }

  return results.map((r, i) => ({
    ...r,
    action: "created" as const,
    productId,
    productHandle: handle,
    inventoryItemId: inventoryIds[i],
    baseSku: skus[i],
    ...(notes.length ? { warning: notes.join("; ") } : {}),
  }))
}

/**
 * Links photos (by URL, already on the product) to the variants of each
 * item, and sets each variant's thumbnail to the item's first photo.
 */
export async function linkItemImages(
  container: any,
  productId: string,
  items: Array<{ inventoryItemId: string; urls: string[] }>,
): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: [product] } = await query.graph({
    entity: "product",
    fields: ["id", "images.id", "images.url", "variants.id", "variants.inventory_items.inventory.id"],
    filters: { id: productId },
  })
  const imageId = new Map<string, string>(((product?.images ?? []) as any[]).map((im) => [im.url, im.id]))
  const productModule: any = container.resolve(Modules.PRODUCT)
  for (const item of items) {
    const ids = item.urls.map((u) => imageId.get(u)).filter(Boolean) as string[]
    if (ids.length === 0) continue
    const variants = ((product?.variants ?? []) as any[])
      .filter((v) => (v.inventory_items ?? []).some((l: any) => l?.inventory?.id === item.inventoryItemId))
    for (const v of variants) {
      await batchVariantImagesWorkflow(container).run({ input: { variant_id: v.id, add: ids } })
      /* The thumbnail is a nicety; the photos are linked either way. */
      await productModule.updateProductVariants(v.id, { thumbnail: item.urls[0] }).catch(() => {})
    }
  }
}

/** Restock and new-product lines that point at the same stock, or a
 *  restock listed twice. */
export function duplicateRestocks(lines: RestockIn[]): string[] {
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const l of lines) {
    if (seen.has(l.inventoryItemId)) dupes.push(l.inventoryItemId)
    seen.add(l.inventoryItemId)
  }
  return dupes
}


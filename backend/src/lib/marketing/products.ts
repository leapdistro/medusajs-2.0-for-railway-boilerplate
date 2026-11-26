import { ContainerRegistrationKeys, QueryContext } from "@medusajs/framework/utils"
import { loadCategoryTree, type CategoryTree } from "../category-tree"
import { storeBrand } from "../brand"

/**
 * Product cards for marketing emails, read live at render time: current
 * name, photo, tier / brand colours, stock, link, and the price for one
 * set of customer groups (a buyer's pricing mode), the same way
 * /store/mbs/products prices for a signed-in buyer. A product that's
 * gone, unpublished or out of stock is left out of the email, so an
 * email never advertises what can't be bought.
 */

export type EmailProduct = {
  id: string
  title: string
  url: string
  image: string | null
  /** Tier or brand name shown on the badge. */
  badge: string
  colors: { swatch: string; surface: string; edge: string }
  /** Cheapest size for this buyer, e.g. { label: "QP", amount: 340 }. */
  price: { label: string; amount: number } | null
  moreSizes: number
  inStock: boolean
}

/* Tier colours = the site's design tokens (CLAUDE.md DESIGN TOKENS);
 * emails can't read CSS variables, so the hex values live here. */
const TIER_COLORS: Record<string, EmailProduct["colors"]> = {
  "tier-classic": { swatch: "#8E918A", surface: "#E7E7E1", edge: "#A3A59D" },
  "tier-exotic": { swatch: "#7FAF4E", surface: "#E1EDD2", edge: "#95BD6C" },
  "tier-super": { swatch: "#DD6A5E", surface: "#F8DEDA", edge: "#E38B80" },
  "tier-snow": { swatch: "#D6B4B3", surface: "#F5E8E7", edge: "#CDA9A8" },
  "tier-rapper": { swatch: "#A285C9", surface: "#E9E0F3", edge: "#AD94CF" },
  "accent-red": { swatch: "#A23A2A", surface: "#F8DEDA", edge: "#E38B80" },
  "accent-purple": { swatch: "#A285C9", surface: "#E9E0F3", edge: "#AD94CF" },
  "accent-copper": { swatch: "#B07A45", surface: "#ECEDDF", edge: "#CBAB83" },
}
const NEUTRAL: EmailProduct["colors"] = { swatch: "#414738", surface: "#ECEDDF", edge: "#B5AF99" }

/* Photo hosts the storefront's email image route accepts (storefront
 * src/lib/media-hosts.ts MEDIA_HOSTS). Photos there load as a 640px
 * square JPEG cropped like the site's product cards (storefront
 * /api/email-img; email clients can't crop, so tall photos made cards of
 * different heights); anything else loads as is. */
const MEDIA_HOSTS = (process.env.MARKETING_IMAGE_HOSTS || "bucket-production-c5c0.up.railway.app")
  .split(",").map((s) => s.trim()).filter(Boolean)

export const storefrontBase = () => (process.env.STOREFRONT_URL || "https://www.hempmbs.com").replace(/\/+$/, "")

export function emailImage(src: string | null | undefined, width = 640): string | null {
  if (!src) return null
  try {
    const u = new URL(src)
    if (!MEDIA_HOSTS.includes(u.hostname)) return src
    return `${storefrontBase()}/api/email-img?u=${encodeURIComponent(src)}&w=${width <= 320 ? 320 : 640}`
  } catch {
    return null
  }
}

const meta = (c: { metadata?: Record<string, unknown> | null } | undefined) => (c?.metadata ?? {}) as Record<string, unknown>

function available(v: any): number {
  if (v?.manage_inventory === false) return Infinity
  const links = (v?.inventory_items ?? []) as any[]
  if (!links.length) return 0
  let min = Infinity
  for (const l of links) {
    const req = Number(l?.required_quantity) || 1
    const levels = (l?.inventory?.location_levels ?? []) as any[]
    const qty = levels.reduce((s, lv) => s + (Number(lv?.stocked_quantity) || 0) - (Number(lv?.reserved_quantity) || 0), 0)
    min = Math.min(min, Math.floor(qty / req))
  }
  return min
}

function toEmailProduct(p: any, tree: CategoryTree): EmailProduct {
  const cats = ((p.categories ?? []) as any[]).filter((c) => tree.byId.get(c.id)?.is_active !== false)
  let path = cats.length ? tree.pathOf(cats[0].id) : []
  for (const c of cats) {
    const pth = tree.pathOf(c.id)
    if (pth.length > path.length) path = pth
  }
  const root = path[0]
  const sub = cats[0]?.handle ?? root?.handle
  const url = root && sub
    ? `${storefrontBase()}/products/${root.handle}/${sub}/${p.handle}`
    : `${storefrontBase()}/products`

  const brand = storeBrand(p.collection)
  const accentLevel = [...path].reverse().find((c) => typeof meta(c).accent === "string" && TIER_COLORS[String(meta(c).accent)])
  const tierLevel = [...path].reverse().find((c) => meta(c).tier_key) ?? accentLevel
  const colors = brand?.shades ?? (accentLevel ? TIER_COLORS[String(meta(accentLevel).accent)] : NEUTRAL)
  const badge = brand?.name ?? tierLevel?.name ?? path[path.length - 1]?.name ?? ""

  const variants = ((p.variants ?? []) as any[])
  const priced = variants
    .map((v) => ({ v, amount: Number(v?.calculated_price?.calculated_amount), stock: available(v) }))
    .filter((x) => Number.isFinite(x.amount) && x.amount > 0)
  const buyable = priced.filter((x) => x.stock > 0)
  const pool = buyable.length ? buyable : priced
  const cheapest = pool.sort((a, b) => a.amount - b.amount)[0]

  return {
    id: p.id,
    title: String(p.title ?? ""),
    url,
    image: emailImage(p.thumbnail || p.images?.[0]?.url),
    badge,
    colors,
    price: cheapest ? { label: String(cheapest.v?.title ?? ""), amount: cheapest.amount } : null,
    moreSizes: Math.max(0, buyable.length - 1),
    inStock: buyable.length > 0,
  }
}

/**
 * Cards for `productIds` priced for `groupIds` (a buyer's customer
 * groups; [] = default prices). Keeps the order of `productIds`.
 * `includeUnavailable` keeps out-of-stock / unpublished products (the
 * editor shows them, marked, so the admin knows why they'd be skipped).
 */
export async function loadEmailProducts(
  scope: any,
  productIds: string[],
  groupIds: string[],
  opts: { includeUnavailable?: boolean } = {},
): Promise<Map<string, EmailProduct>> {
  const out = new Map<string, EmailProduct>()
  if (!productIds.length) return out
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const pricingContext: Record<string, any> = { currency_code: "usd" }
  if (groupIds.length) pricingContext.customer = { groups: groupIds.map((id) => ({ id })) }
  const [{ data }, tree] = await Promise.all([
    query.graph({
      entity: "product",
      fields: [
        "id", "title", "handle", "thumbnail", "status", "images.url",
        "categories.id", "categories.handle",
        "collection.handle", "collection.title", "collection.metadata",
        "variants.id", "variants.title", "variants.manage_inventory",
        "variants.calculated_price.calculated_amount",
        "variants.inventory_items.required_quantity",
        "variants.inventory_items.inventory.location_levels.stocked_quantity",
        "variants.inventory_items.inventory.location_levels.reserved_quantity",
      ],
      filters: { id: productIds },
      context: { variants: { calculated_price: QueryContext(pricingContext) } },
    }),
    loadCategoryTree(query),
  ])
  const byId = new Map(((data ?? []) as any[]).map((p) => [p.id, p]))
  for (const id of productIds) {
    const p = byId.get(id)
    if (!p) continue
    const card = toEmailProduct(p, tree)
    const live = p.status === "published" && card.inStock
    if (live || opts.includeUnavailable) out.set(id, { ...card, inStock: live })
  }
  return out
}

/** Product picker search for the editor (no prices: those depend on the buyer). */
export async function searchProducts(scope: any, q: string, limit = 40, ids?: string[]) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const filters: Record<string, unknown> = ids?.length ? { id: ids } : { status: "published" }
  if (!ids?.length && q.trim()) filters.q = q.trim()
  const [{ data }, tree] = await Promise.all([
    query.graph({
      entity: "product",
      fields: [
        "id", "title", "handle", "thumbnail", "created_at", "images.url",
        "categories.id", "categories.handle", "collection.handle", "collection.title", "collection.metadata",
        "variants.id", "variants.manage_inventory",
        "variants.inventory_items.required_quantity",
        "variants.inventory_items.inventory.location_levels.stocked_quantity",
        "variants.inventory_items.inventory.location_levels.reserved_quantity",
      ],
      filters,
      pagination: { take: ids?.length ? ids.length : limit, order: { created_at: "DESC" } },
    }),
    loadCategoryTree(query),
  ])
  return ((data ?? []) as any[]).map((p) => {
    const card = toEmailProduct(p, tree)
    const top = (p.categories ?? []).map((c: any) => tree.rootOf(c.id)).find(Boolean)
    return {
      id: p.id,
      title: card.title,
      image: p.thumbnail || p.images?.[0]?.url || null,
      badge: card.badge,
      category: top?.name ?? "",
      colors: card.colors,
      inStock: card.inStock,
      createdAt: p.created_at,
    }
  })
}

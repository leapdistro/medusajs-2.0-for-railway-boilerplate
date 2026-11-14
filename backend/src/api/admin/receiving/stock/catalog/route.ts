import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { findProfile, resolveProfileCategories } from "../../../../../lib/profile-store"
import { categoriesForProfiles } from "../../../../../lib/price-scope"
import { tableFor } from "../../../../../lib/price-levels"
import { PACK_OPTION } from "../../../../../lib/stock-receive"
import { MBS_SETTINGS_MODULE } from "../../../../../modules/mbs-settings"

/**
 * GET /admin/receiving/stock/catalog?key=<profile key>
 *
 * Everything the Receive stock screen matches invoice lines against:
 * one entry per item (inventory item: a product, or one flavour of it)
 * with its UPC, box / case prices, current landed cost, stock and its
 * last receivings (cost history), plus the category's sub-categories,
 * the brand names and the Owner Stores markup.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const key = String(req.query.key ?? "")
  const profile = await findProfile(req.scope, key)
  if (!profile) return res.status(404).json({ error: `Unknown category: ${key}` })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const productModule: any = req.scope.resolve(Modules.PRODUCT)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)

  const resolved = await resolveProfileCategories(query, profile)
  const scoped = await categoriesForProfiles(query, [profile])
  const categoryIds = [...scoped.keys()]

  const ids: string[] = categoryIds.length
    ? (await productModule.listProducts({ categories: { id: categoryIds } }, { select: ["id"], take: 5000 })).map((p: any) => p.id)
    : []
  const { data: products } = ids.length
    ? await query.graph({
        entity: "product",
        fields: [
          "id", "title", "handle", "thumbnail", "description", "status",
          "collection.title", "categories.id",
          "options.title", "options.values.value",
          "variants.id", "variants.title", "variants.barcode", "variants.thumbnail", "variants.metadata",
          "variants.options.value", "variants.options.option.title",
          "variants.price_set.prices.id", "variants.price_set.prices.amount",
          "variants.price_set.prices.currency_code", "variants.price_set.prices.price_list_id",
          "variants.inventory_items.required_quantity",
          "variants.inventory_items.inventory.id", "variants.inventory_items.inventory.metadata",
          "variants.inventory_items.inventory.location_levels.stocked_quantity",
        ],
        filters: { id: ids },
      })
    : { data: [] }

  const amountOf = (a: any) => Number(a?.value ?? a?.numeric ?? a)
  type Item = {
    inventoryItemId: string
    productId: string
    productTitle: string
    brand: string | null
    categoryId: string | null
    status: string
    values: Record<string, string>
    upc: string | null
    thumbnail: string | null
    box: { variantId: string; price: number | null; label: string } | null
    case: { variantId: string; price: number | null; perCase: number } | null
    piecesPerBox: number | null
    pieceName: string | null
    landed: number | null
    stock: number
    history: Array<{ date: string; supplier: string | null; invoice: string | null; cost: number | null; landed: number; boxPrice: number | null; qty: number }>
  }
  const items = new Map<string, Item>()
  for (const p of products as any[]) {
    for (const v of (p.variants ?? []) as any[]) {
      const link = (v.inventory_items ?? [])[0]
      const inv = link?.inventory
      if (!inv?.id) continue
      const units = Number(link.required_quantity) || 1
      const item: Item = items.get(inv.id) ?? {
        inventoryItemId: inv.id,
        productId: p.id,
        productTitle: p.title,
        brand: p.collection?.title ?? null,
        categoryId: (p.categories ?? []).find((c: any) => scoped.has(c.id))?.id ?? null,
        status: p.status,
        values: {},
        upc: null,
        thumbnail: v.thumbnail ?? p.thumbnail ?? null,
        box: null,
        case: null,
        piecesPerBox: null,
        pieceName: null,
        landed: Number.isFinite(Number(inv.metadata?.landed_per_qp)) ? Number(inv.metadata.landed_per_qp) : null,
        stock: (inv.location_levels ?? []).reduce((s: number, l: any) => s + (Number(l?.stocked_quantity) || 0), 0),
        history: [],
      }
      const price = ((v.price_set?.prices ?? []) as any[]).find((x) => x.currency_code === "usd" && !x.price_list_id)
      const values: Record<string, string> = {}
      let packValue: string | null = null
      for (const o of (v.options ?? []) as any[]) {
        const t = o?.option?.title
        if (!t || !o.value) continue
        if (t === PACK_OPTION) packValue = o.value
        else values[t] = o.value
      }
      if (Object.keys(values).length > Object.keys(item.values).length) item.values = values
      if (units === 1 && !item.box) {
        item.box = { variantId: v.id, price: price ? amountOf(price.amount) : null, label: packValue ?? v.title }
        item.upc = v.barcode ?? null
        item.thumbnail = v.thumbnail ?? item.thumbnail
        const per = Number(v.metadata?.pieces_per_box)
        item.piecesPerBox = Number.isFinite(per) && per > 0 ? per : null
        item.pieceName = v.metadata?.piece_name ?? null
      } else if (units > 1 && !item.case) {
        item.case = { variantId: v.id, price: price ? amountOf(price.amount) : null, perCase: units }
      }
      items.set(inv.id, item)
    }
  }

  /* Cost history: the last receivings of each item, newest first. */
  const invIds = [...items.keys()]
  if (invIds.length) {
    const { rows } = await pg.raw(
      `select l->>'inventoryItemId' as inv, l->>'qtyQps' as qty, l->>'landedPerQp' as landed,
              l->>'cost' as cost, l->>'boxPrice' as box_price,
              r.invoice_date, r.invoice_number, r.supplier->>'name' as supplier, r.created_at
         from receiving_record r, jsonb_array_elements(r.line_results::jsonb) l
        where r.deleted_at is null
          and l->>'inventoryItemId' = any(?)
          and l->>'action' in ('created', 'restocked')
        order by r.created_at desc`,
      [invIds],
    )
    for (const r of rows as any[]) {
      const item = items.get(r.inv)
      if (!item || item.history.length >= 6) continue
      const n = (x: unknown) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x))
      item.history.push({
        date: String(r.invoice_date ?? r.created_at ?? "").slice(0, 10),
        supplier: r.supplier ?? null,
        invoice: r.invoice_number ?? null,
        cost: n(r.cost),
        landed: n(r.landed) ?? 0,
        boxPrice: n(r.box_price),
        qty: n(r.qty) ?? 0,
      })
    }
  }

  const collections = await productModule.listProductCollections({}, { select: ["title"], take: 1000 })
  const ownerKey = tableFor(profile, "owner")
  const ownerMarkup = ownerKey ? await settings.getSetting(ownerKey).catch(() => null) : null

  return res.json({
    profile: {
      key: profile.key,
      displayName: profile.displayName,
      invoiceUpload: !!profile.invoiceUpload,
      subcategories: resolved.profile.subcategories.map((s: any) => ({ id: s.id, name: s.medusaName, label: s.label })),
      ownerMarkupKey: ownerKey,
      ownerMarkup: Number.isFinite(Number(ownerMarkup)) && ownerMarkup !== null ? Number(ownerMarkup) : null,
    },
    brands: (collections as any[]).map((c) => c.title).filter(Boolean).sort((a: string, b: string) => a.localeCompare(b)),
    items: [...items.values()],
    products: (products as any[]).map((p) => ({
      id: p.id,
      title: p.title,
      brand: p.collection?.title ?? null,
      options: ((p.options ?? []) as any[]).filter((o) => o.title !== PACK_OPTION).map((o) => ({ title: o.title, values: (o.values ?? []).map((x: any) => x.value) })),
    })),
  })
}

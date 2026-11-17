import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * In-process cache for the storefront catalog (/store/mbs/products, full
 * list and index view). Building it is a ~2s query.graph (every variant's
 * calculated price, inventory, categories…), and the storefront asks for
 * it on every catalog page view; under bursts the requests queued behind
 * each other for 10–60s (audit 2026-11-16).
 *
 * What's cached, and how it stays correct:
 *   - Products, categories, brands and prices are cached per pricing key
 *     (anonymous, or the buyer's customer-group ids: 5 pricing modes, so
 *     a handful of entries). An entry is used only while the catalog
 *     fingerprint is unchanged: a hash of every row of the product*,
 *     price* and image tables (products, variants, options, images,
 *     categories, collections, attributes, their links, price sets, price
 *     lists and rules). Any edit, receiving, Save & Apply or price change
 *     changes it, whichever code path made the change, so there's no event
 *     to miss. The fingerprint is re-read at most every FP_TTL_MS, and an
 *     entry is rebuilt after MAX_AGE_MS regardless (time-based price-list
 *     starts / ends change prices without changing a row).
 *   - Stock is never cached with it: each response gets the inventory
 *     levels read fresh (one small query, shared for STOCK_TTL_MS).
 *
 * Concurrent requests for the same entry share one build (single flight).
 * Callers fall back to the uncached query if anything here throws.
 */

const FP_TTL_MS = 5_000
const STOCK_TTL_MS = 2_000
const MAX_AGE_MS = 10 * 60_000

type Level = { stocked_quantity: number; reserved_quantity: number }

let tables: Promise<string[]> | null = null
let fp: { at: number; value: Promise<string> } | null = null
let stock: { at: number; value: Promise<Map<string, Level[]>> } | null = null
const entries = new Map<string, { fp: string; at: number; products: Promise<any[]> }>()

function pgOf(scope: any) {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
}

async function fingerprintTables(pg: any): Promise<string[]> {
  const { rows } = await pg.raw(
    `select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
        and (table_name like 'product%' or table_name like 'price%' or table_name = 'image')
      order by table_name`,
  )
  const names = rows.map((r: any) => String(r.table_name))
  if (!names.includes("product") || !names.includes("price")) {
    throw new Error(`catalog cache: product / price tables not found (${names.join(", ")})`)
  }
  console.info(`[catalog-cache] fingerprint tables: ${names.join(", ")}`)
  return names
}

/** Changes whenever any row of a catalog table is added, changed or
 *  removed (row hashes summed, so order doesn't matter). */
export async function catalogFingerprint(scope: any): Promise<string> {
  const now = Date.now()
  if (fp && now - fp.at < FP_TTL_MS) return fp.value
  const pg = pgOf(scope)
  const value = (async () => {
    tables ??= fingerprintTables(pg).catch((e) => { tables = null; throw e })
    const names = await tables
    const parts = names.map((t) => `(select count(*) || ':' || coalesce(sum(hashtext(x::text)::bigint), 0) from "${t}" x)`)
    const { rows } = await pg.raw(`select md5(${parts.join(" || '|' || ")}) as fp`)
    if (Date.now() - now > 300) console.warn(`[catalog-cache] fingerprint took ${Date.now() - now}ms`)
    return String(rows[0].fp)
  })()
  fp = { at: now, value }
  value.catch(() => { if (fp?.value === value) fp = null })
  return value
}

/** The cached products for this key, built with `build` when the catalog
 *  changed or the entry is older than MAX_AGE_MS. Treat the result as
 *  shared: only `respondWithStock` may change it. */
export async function cachedCatalog(key: string, fingerprint: string, build: () => Promise<any[]>): Promise<any[]> {
  const now = Date.now()
  const hit = entries.get(key)
  if (hit && hit.fp === fingerprint && now - hit.at < MAX_AGE_MS) return hit.products
  const reason = !hit ? "first use" : hit.fp !== fingerprint ? "catalog changed" : "max age"
  const products = build().then((list) => {
    console.info(`[catalog-cache] built ${key} (${reason}): ${list.length} products in ${Date.now() - now}ms`)
    return list
  })
  entries.set(key, { fp: fingerprint, at: now, products })
  products.catch(() => { if (entries.get(key)?.products === products) entries.delete(key) })
  return products
}

async function freshStock(scope: any): Promise<Map<string, Level[]>> {
  const now = Date.now()
  if (stock && now - stock.at < STOCK_TTL_MS) return stock.value
  const pg = pgOf(scope)
  const value = (async () => {
    const { rows } = await pg.raw(
      `select inventory_item_id, stocked_quantity, reserved_quantity
         from inventory_level where deleted_at is null`,
    )
    const byItem = new Map<string, Level[]>()
    for (const r of rows) {
      const list = byItem.get(r.inventory_item_id) ?? []
      list.push({ stocked_quantity: Number(r.stocked_quantity), reserved_quantity: Number(r.reserved_quantity) })
      byItem.set(r.inventory_item_id, list)
    }
    return byItem
  })()
  stock = { at: now, value }
  value.catch(() => { if (stock?.value === value) stock = null })
  return value
}

/** Serialize the cached products with stock read now. The overlay and the
 *  stringify run without an await between them, so concurrent requests
 *  can't see each other's stock. */
export async function catalogBodyWithStock(scope: any, products: any[]): Promise<string> {
  const levels = await freshStock(scope)
  for (const p of products) {
    for (const v of p.variants ?? []) {
      for (const ii of v.inventory_items ?? []) {
        if (ii?.inventory && ii.inventory_item_id) ii.inventory.location_levels = levels.get(ii.inventory_item_id) ?? []
      }
    }
  }
  return JSON.stringify({ products, count: products.length })
}

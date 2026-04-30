import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Hits the LOCAL dev server's /store/mbs/products endpoint directly
 * (the same endpoint the storefront calls) — bypasses curl quoting
 * pain. Tells us whether the handle filter works.
 *
 * Run: pnpm test:store-products
 */
export default async function testStoreProducts({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const apiKeyService: any = container.resolve(Modules.API_KEY)

  /* Auto-resolve the publishable key from DB so we don't have to copy/paste. */
  const keys = await apiKeyService.listApiKeys({ type: "publishable" })
  const defaultKey = keys.find((k: any) => /default/i.test(k.title)) || keys[0]
  if (!defaultKey) {
    logger.error("No publishable API key found.")
    return
  }
  const token = defaultKey.token
  logger.info(`Using key: ${defaultKey.title} (${token.slice(0, 14)}…)`)

  const handle = process.env.HANDLE || "gold-rose-runtz"
  const url = `http://localhost:9000/store/mbs/products?handle=${encodeURIComponent(handle)}`
  logger.info(`▶ GET ${url}`)

  const res = await fetch(url, {
    headers: { "x-publishable-api-key": token },
  })
  const json: any = await res.json().catch(() => null)
  logger.info(`status: ${res.status}`)
  logger.info(`count:  ${json?.count ?? "?"}`)

  if (!json?.products || json.products.length === 0) {
    logger.warn("✗ No products returned. Endpoint or filter is broken.")
    if (json) logger.info(`raw response: ${JSON.stringify(json).slice(0, 500)}`)
    return
  }

  for (const p of json.products) {
    logger.info(`  · ${p.title}  handle=${p.handle}  status=${p.status}`)
    logger.info(`      attributes: ${p.product_attributes ? "✓ linked" : "✗ NOT LINKED"}`)
    logger.info(`      categories: ${(p.categories ?? []).map((c: any) => `${c.name}${c.parent_category_id ? "(sub)" : ""}`).join(", ")}`)
    logger.info(`      variants:   ${(p.variants ?? []).length}`)
    for (const v of p.variants ?? []) {
      const opts = (v.options ?? []).map((o: any) => `${o.option?.title}=${o.value}`).join(", ")
      const prices = v.price_set?.prices ?? []
      const priceStr = prices.length === 0 ? "✗ NONE" : prices.map((px: any) => `${px.currency_code} ${px.amount}`).join(", ")
      logger.info(`        · ${v.title}  options=[${opts}]  prices=[${priceStr}]`)
    }
  }
}

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Quick read-only diagnostic — prints every product in the DB with its
 * handle, status, categories (full path), and variant count. Useful
 * for figuring out what URL the storefront would render for a given
 * strain.
 *
 * Run: pnpm inspect:products
 */
export default async function inspectProducts({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "status",
      "categories.id",
      "categories.name",
      "categories.handle",
      "categories.parent_category_id",
      "options.title",
      "options.values.value",
      "variants.id",
      "variants.title",
      "variants.sku",
      "variants.weight",
      "variants.options.value",
      "variants.options.option.title",
      "variants.price_set.id",
      "variants.price_set.prices.amount",
      "variants.price_set.prices.currency_code",
      "sales_channels.id",
      "sales_channels.name",
      "product_attributes.id",
      "product_attributes.strain_type",
      "product_attributes.best_for",
      "product_attributes.thca_percent",
      "product_attributes.total_cannabinoids_percent",
      "product_attributes.effects",
      "product_attributes.coa_url",
    ],
  })

  if (!products || products.length === 0) {
    logger.info("No products found in DB.")
    return
  }

  /* Build parent map so we can render full category paths. */
  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })
  const catById = new Map<string, { name: string; parent_category_id: string | null }>()
  for (const c of allCats as any[]) {
    catById.set(c.id, { name: c.name, parent_category_id: c.parent_category_id ?? null })
  }
  const fullPath = (catId: string): string => {
    const parts: string[] = []
    let cur: string | null = catId
    while (cur) {
      const c: { name: string; parent_category_id: string | null } | undefined = catById.get(cur)
      if (!c) break
      parts.unshift(c.name)
      cur = c.parent_category_id
    }
    return parts.join(" / ")
  }

  logger.info(`▶ ${products.length} product(s) in DB`)
  logger.info("─────────────────────────────────────────────────")
  for (const p of products as any[]) {
    const cats = (p.categories ?? []).map((c: any) => `${fullPath(c.id)} (handle=${c.handle ?? "-"}, parent=${c.parent_category_id ? "yes" : "no"})`).join("; ") || "(no category)"
    const variantCount = (p.variants ?? []).length
    const channels = (p.sales_channels ?? []).map((s: any) => s.name).join(", ") || "(no channels)"
    const attrs = p.product_attributes
    logger.info(`  · ${(p.title ?? "(no title)").padEnd(28)} handle=${p.handle ?? "-"}  [${p.status}]`)
    logger.info(`      categories:  ${cats}`)
    logger.info(`      channels:    ${channels}`)
    logger.info(`      variants:    ${variantCount}`)
    const productOpts = (p.options ?? []).map((o: any) => `${o.title}=[${(o.values ?? []).map((v: any) => v.value).join(",")}]`).join(" · ") || "(none)"
    logger.info(`      options:     ${productOpts}`)
    if (variantCount > 0) {
      for (const v of p.variants as any[]) {
        const prices = v.price_set?.prices ?? []
        const priceStr = prices.length === 0
          ? "✗ NO PRICES SET"
          : prices.map((p: any) => `${p.currency_code.toUpperCase()} ${p.amount}`).join(", ")
        const opts = (v.options ?? []).map((o: any) => `${o.option?.title ?? "?"}=${o.value}`).join(", ") || "(no options)"
        const weightStr = v.weight != null ? `${v.weight}g` : "✗ NO WEIGHT (margin calc will hide)"
        logger.info(`        · ${v.title.padEnd(20)} sku=${(v.sku ?? "-").padEnd(28)} prices=${priceStr}  weight=${weightStr}`)
        logger.info(`            options: ${opts}`)
      }
    }
    if (attrs) {
      logger.info(`      attributes:  ✓ linked (id=${attrs.id})`)
      logger.info(`        strain_type=${attrs.strain_type ?? "-"}  best_for=${attrs.best_for ?? "-"}`)
      logger.info(`        thca=${attrs.thca_percent ?? "-"}  cann=${attrs.total_cannabinoids_percent ?? "-"}`)
      logger.info(`        effects=${JSON.stringify(attrs.effects ?? null)}`)
      logger.info(`        coa_url=${attrs.coa_url ?? "(none)"}`)
    } else {
      logger.info(`      attributes:  ✗ NOT LINKED — storefront will return 404`)
    }
  }
  logger.info("─────────────────────────────────────────────────")
}

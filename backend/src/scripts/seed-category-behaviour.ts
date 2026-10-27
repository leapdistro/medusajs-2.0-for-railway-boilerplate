import { Modules } from "@medusajs/framework/utils"

/**
 * One-off (P7): moves the storefront's hardcoded product behaviour into
 * category.metadata, under "Products in this category" on the category's
 * Storefront display panel. A product reads each key from its nearest
 * category that sets it (Flower → CBD → Classic). Values reproduce what
 * the storefront did by category handle:
 *   cannabinoid — which % the product shows, its filter and label rows
 *   productMeta — the small line on each product card
 *   labels      — products can print shelf labels (flower only)
 *   filterLabel — "Tier" for flower's subcategory filter (else "Type")
 *   seoTitle    — page titles the storefront special-cased by handle
 *
 * Merges into each category's existing metadata; keys already set to
 * the same value are skipped. Dry run unless APPLY=1.
 *
 *   APPLY=1 npx medusa exec ./src/scripts/seed-category-behaviour.ts
 */
const PLAN: Record<string, Record<string, unknown>> = {
  "flower": { cannabinoid: "thc-a", labels: true, filterLabel: "Tier" },
  "flower-thc-a": { cannabinoid: "thc-a", seoTitle: "THC-A Flower · Wholesale Catalog" },
  "flower-cbd": { cannabinoid: "cbd" },
  "flower-cbg": { cannabinoid: "cbg" },
  "thc-p": { cannabinoid: "thc-p", seoTitle: "THC-P Flower · Wholesale Case-Pack (8-jar Box)" },
  "pre-rolls": { cannabinoid: "thc-a", productMeta: "Pre-Rolls · 30/box · 1.5g each" },
  "cbd": { cannabinoid: "cbd" },
  "hashholes": { productMeta: "Hashholes · 15 tubes · 2/tube" },
}

export default async function seedCategoryBehaviour({ container }: any) {
  const apply = process.env.APPLY === "1"
  const products: any = container.resolve(Modules.PRODUCT)
  const cats: any[] = await products.listProductCategories({}, { take: 500, select: ["id", "handle", "metadata"] })
  const byHandle = new Map(cats.map((c) => [c.handle, c]))
  let changed = 0
  for (const [handle, patch] of Object.entries(PLAN)) {
    const cat = byHandle.get(handle)
    if (!cat) { console.log(`MISSING ${handle}`); continue }
    const cur = cat.metadata ?? {}
    const diff = Object.entries(patch).filter(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v))
    if (diff.length === 0) { console.log(`same    ${handle}`); continue }
    changed++
    console.log(`${apply ? "update" : "would  "} ${handle}: ${diff.map(([k, v]) => `${k}=${JSON.stringify(v)}${cur[k] !== undefined ? ` (was ${JSON.stringify(cur[k])})` : ""}`).join(", ")}`)
    if (apply) await products.updateProductCategories(cat.id, { metadata: { ...cur, ...patch } })
  }
  console.log(`${apply ? "Updated" : "Would update"} ${changed} categories.`)
}

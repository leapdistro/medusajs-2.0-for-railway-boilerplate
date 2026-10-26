import { Modules } from "@medusajs/framework/utils"

/**
 * One-off (P6): moves the storefront's hardcoded category display
 * settings into category.metadata, where the "Storefront display"
 * widget edits them: tile images, colours, CBD intro copy, sort order
 * for the retired branches, and the two home-page sections (CBD flower,
 * Pre-Rolls). Values are what the storefront showed before, so the site
 * looks the same once it reads metadata instead.
 *
 * Merges into each category's existing metadata; keys already set to
 * the same value are skipped. Dry run unless APPLY=1.
 *
 *   APPLY=1 npx medusa exec ./src/scripts/seed-category-display.ts
 */
const PLAN: Record<string, Record<string, unknown>> = {
  "flower": {
    "tileImage": "/images/flower-tier/shop-all.png"
  },
  "flower-cbd": {
    "intro": "Texas-compliant CBD flower. Total THC (THCA × 0.877 + D9) < 0.3%.",
    "homeOrder": 1,
    "homeEyebrow": "Catalog",
    "homeTitle": "CBD",
    "homeTitleAccent": "flower",
    "homeSubtitle": "Texas Total THC (THCA × 0.877 + D9) < 0.3% · full tier ladder.",
    "homePriceUnit": "qp",
    "homeShopAllHref": "/products?cannabinoid=cbd"
  },
  "flower-cbg": {
    "accent": "accent-purple"
  },
  "flower-thc-a": {
    "sortOrder": 5
  },
  "thc-p": {
    "sortOrder": 60,
    "accent": "accent-copper"
  },
  "cbd-classic": {
    "accent": "tier-classic",
    "tileImage": "/images/flower-tier/classic.png",
    "intro": "Texas-compliant CBD flower. Total THC (THCA × 0.877 + D9) < 0.3%."
  },
  "cbd-exotic": {
    "accent": "tier-exotic",
    "tileImage": "/images/flower-tier/exotic.png",
    "intro": "Texas-compliant CBD flower. Total THC (THCA × 0.877 + D9) < 0.3%."
  },
  "cbd-super": {
    "accent": "tier-super",
    "tileImage": "/images/flower-tier/super.png",
    "intro": "Texas-compliant CBD flower. Total THC (THCA × 0.877 + D9) < 0.3%."
  },
  "cbd-snowcaps": {
    "accent": "tier-snow",
    "tileImage": "/images/flower-tier/snowcaps.png",
    "intro": "Texas-compliant CBD flower. Total THC (THCA × 0.877 + D9) < 0.3%."
  },
  "cbd-rapper": {
    "accent": "tier-rapper",
    "tileImage": "/images/flower-tier/rapper.png",
    "intro": "Texas-compliant CBD flower. Total THC (THCA × 0.877 + D9) < 0.3%."
  },
  "cbg-classic": {
    "accent": "tier-classic",
    "tileImage": "/images/flower-tier/classic.png"
  },
  "cbg-exotic": {
    "accent": "tier-exotic",
    "tileImage": "/images/flower-tier/exotic.png"
  },
  "cbg-super": {
    "accent": "tier-super",
    "tileImage": "/images/flower-tier/super.png"
  },
  "cbg-snowcaps": {
    "accent": "tier-snow",
    "tileImage": "/images/flower-tier/snowcaps.png"
  },
  "cbg-rapper": {
    "accent": "tier-rapper",
    "tileImage": "/images/flower-tier/rapper.png"
  },
  "classic": {
    "tileImage": "/images/flower-tier/classic.png"
  },
  "exotic": {
    "tileImage": "/images/flower-tier/exotic.png"
  },
  "super": {
    "tileImage": "/images/flower-tier/super.png"
  },
  "snowcaps": {
    "tileImage": "/images/flower-tier/snowcaps.png"
  },
  "rapper": {
    "tileImage": "/images/flower-tier/rapper.png"
  },
  "pre-rolls": {
    "tileImage": "/images/pre-rolls/thc-a.png",
    "homeOrder": 2,
    "homeEyebrow": "Pre-Rolls",
    "homeTitle": "{count} type{s}",
    "homeTitleAccent": "pre-rolls",
    "homeSubtitle": "Single-strain {names} pre-rolls.",
    "homePriceUnit": "box"
  },
  "cbd": {
    "tileMeta": "30 pre-rolls per box",
    "tileImage": "/images/pre-rolls/thc-a.png"
  },
  "hashholes": {
    "tileMeta": "15 tubes · 2 per tube",
    "tileRetail": "2/$10"
  }
}

export default async function seedCategoryDisplay({ container }: any) {
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

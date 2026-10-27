/* P8 check: a new top-level category end to end, with nothing left behind.
 * Creates ZZ Test Edibles → Gummies (inactive: the store never sees it),
 * adds a test receiving profile + price table IN MEMORY only, runs the
 * real admin/store routes against it, prints what each returns, and
 * deletes both categories. No settings, products, history or QBO writes.
 *
 *   OUT=/tmp/p8.json npx medusa exec ./src/scripts/check-new-category.ts */
import { writeFileSync } from "fs"
import { Modules } from "@medusajs/framework/utils"
import { normalizeProfile } from "../lib/profile-store"
import { GET as profilesGET } from "../api/admin/mbs/category-profiles/route"
import { POST as savePOST } from "../api/admin/receiving/save/route"
import { GET as linesGET } from "../api/admin/product-lines/route"
import { GET as tablesGET } from "../api/admin/mbs/price-tables/route"
import { loadCategoryTree, productPath } from "../lib/category-tree"

const call = async (fn: any, container: any, body: any = {}, query: any = {}) => {
  let out: any, status = 200
  const res: any = { json: (b: any) => { out = b }, status: (s: number) => { status = s; return res }, setHeader: () => res }
  await fn({ scope: container, body, query, params: {}, headers: {}, auth_context: { actor_id: "p8-test" } } as any, res)
  return { status, body: out }
}

export default async function run({ container }: any) {
  const products: any = container.resolve(Modules.PRODUCT)
  const settings: any = container.resolve("mbsSettingsModuleService")
  const report: any = {}
  const [top] = await products.createProductCategories([{
    name: "ZZ Test Edibles", handle: "zz-test-edibles", is_active: false, is_internal: false,
    metadata: { cannabinoid: "cbd", productMeta: "Edibles · 20 pieces", filterLabel: "Type",
      productFields: [{ key: "per_piece", label: "Per piece", unit: "mg" }, { key: "flavor", label: "Flavor" }] },
  }])
  const [child] = await products.createProductCategories([{
    name: "Gummies", handle: "zz-test-gummies", parent_category_id: top.id, is_active: false,
    metadata: { accent: "accent-copper", productFields: [{ key: "per_piece", label: "CBD per gummy", unit: "mg" }] },
  }])
  console.log("CREATED", top.id, child.id)
  try {
    const { profile, errors } = normalizeProfile({
      key: "zz-test", displayName: "ZZ Test Edibles", categoryId: top.id, parentCategoryName: "ZZ Test Edibles",
      subcategories: [{ key: "gummies", categoryId: child.id, medusaName: "Gummies", label: "Gummies",
        variants: [{ sizeKey: "20pk", label: "20 ct Bag", multiplier: 1, unitLabel: "pc", unitsPerVariant: 20 }] }],
      variants: [],
      fields: { strainType: false, bestFor: false, effects: false, cannabinoids: true, coaRequired: false, upc: true },
      pricingModel: "tier", tierPricesSettingKey: "zz_test_tier_prices",
      unitLabel: { singular: "Bag", plural: "Bags" }, inputUnitLabel: { singular: "bag", plural: "bags" }, inputToPoolMultiplier: 1,
      priceTables: {}, shippingRatesKey: "preroll", primaryCannabinoid: "CBD", invoiceUpload: false,
      otherCannabinoids: [{ cannabinoid: "D9", required: true }],
    })
    report.profileErrors = errors
    /* In-memory only: the live profiles plus the test one, and its price table. */
    const realGet = settings.getSetting.bind(settings)
    settings.getSetting = async (key: string, fallback?: any) => {
      if (key === "category_profiles") return [...((await realGet(key, fallback)) ?? []), profile]
      if (key === "zz_test_tier_prices") return { gummies: { "20pk": 25 } }
      return realGet(key, fallback)
    }
    settings.setSetting = async () => { throw new Error("P8 run must not write settings") }

    const prof = await call(profilesGET, container)
    report.categoriesTab = prof.body.profiles.find((p: any) => p.key === "zz-test")
    report.categoriesTabUnlinkedHasTest = prof.body.unlinked.some((c: any) => c.id === top.id)

    const preview = await call(savePOST, container, {
      preview: true, profileKey: "zz-test",
      supplier: { name: "P8 Test Supplier" }, invoiceNumber: "P8-TEST-0001", invoiceDate: "2026-10-27",
      shippingTotal: 0, total: 200,
      rows: [{ strainName: "Sour Watermelon Test", quantity: 10, unitPrice: 20, tier: "gummies",
        strainType: "Hybrid", bestFor: "day", effects: [], coaUrl: null, coaOriginalName: null,
        thcaPercent: null, totalCannabinoidsPercent: "25", cbdPercent: "25", d9Percent: "0.1", upc: "000000000017" }],
    })
    report.preview = { status: preview.status, body: preview.body }

    const lines = await call(linesGET, container)
    report.productLine = lines.body.branches.find((b: any) => b.key === "zz-test-gummies")

    const tables = await call(tablesGET, container)
    report.priceTables = JSON.stringify(tables.body).includes("zz-test") ? "listed" : "not listed"
    report.priceTablesSample = JSON.stringify(tables.body).slice(0, 400)

    const tree = await loadCategoryTree(container.resolve("query"))
    report.categoryPath = productPath(tree, [child.id])
  } finally {
    await products.deleteProductCategories([child.id])
    await products.deleteProductCategories([top.id])
    const left = await products.listProductCategories({ handle: ["zz-test-edibles", "zz-test-gummies"] })
    console.log("DELETED, remaining:", left.length)
  }
  writeFileSync(process.env.OUT!, JSON.stringify(report, null, 1))
  console.log("REPORT written")
}

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Read-only. Per category, how many live products have each cannabinoid
 * % stored, plus every pre-roll's values, so the pre-roll CBD % / D9 %
 * switch and backfill can be checked against the real data.
 *
 *   npx medusa exec ./src/scripts/cannabinoid-fields-audit.ts
 */
export default async function cannabinoidFieldsAudit({ container }: { container: any }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: cats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })
  const byId = new Map((cats as any[]).map((c) => [c.id, c]))
  const pathOf = (id: string) => {
    const names: string[] = []
    for (let c = byId.get(id); c; c = c.parent_category_id ? byId.get(c.parent_category_id) : undefined) names.unshift(c.name)
    return names.join(" › ")
  }
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "title", "categories.id",
      "product_attributes.thca_percent", "product_attributes.cbd_percent", "product_attributes.cbg_percent",
      "product_attributes.d9_percent", "product_attributes.total_cannabinoids_percent",
      "product_attributes.coa_url", "product_attributes.batch_id",
    ],
  })
  const fields = ["thca_percent", "cbd_percent", "cbg_percent", "d9_percent", "total_cannabinoids_percent"]
  const tally = new Map<string, { n: number; has: Record<string, number> }>()
  const prerolls: any[] = []
  for (const p of products as any[]) {
    const path = pathOf(p.categories?.[0]?.id ?? "") || "(none)"
    const a = p.product_attributes ?? {}
    const t = tally.get(path) ?? { n: 0, has: Object.fromEntries(fields.map((f) => [f, 0])) }
    t.n++
    for (const f of fields) if (a[f] != null && String(a[f]).trim() !== "") t.has[f]++
    tally.set(path, t)
    if (path.startsWith("Pre-Rolls")) prerolls.push({ path, title: p.title, ...Object.fromEntries(fields.map((f) => [f, a[f] ?? null])), coa: a.coa_url ? "yes" : "no", batch: a.batch_id ?? null })
  }
  console.log("category · products · " + fields.join(" / "))
  for (const [path, t] of Array.from(tally.entries()).sort()) {
    console.log(`  ${path} · ${t.n} · ${fields.map((f) => t.has[f]).join(" / ")}`)
  }
  console.log("\nPre-rolls:")
  for (const r of prerolls) console.log("  " + JSON.stringify(r))
}

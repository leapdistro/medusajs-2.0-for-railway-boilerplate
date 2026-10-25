import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { extractCoa } from "../lib/ai-coa-extraction"

/**
 * Read-only (calls the AI, writes nothing). Runs the COA extractor on a
 * few real CBD COAs — pre-rolls and CBD flower — and compares what it
 * reads with the stored CBD %, D9 % and batch id. Also asks for THCa
 * (an "also record" cannabinoid) and compares it with stored THCa %.
 *
 *   ANTHROPIC_API_KEY=… npx medusa exec ./src/scripts/coa-d9-extract-check.ts
 */
export default async function coaD9ExtractCheck({ container }: { container: any }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: cats } = await query.graph({ entity: "product_category", fields: ["id", "name", "parent_category_id"] })
  const byId = new Map((cats as any[]).map((c) => [c.id, c]))
  const rootOf = (id: string) => {
    let c = byId.get(id)
    while (c?.parent_category_id) c = byId.get(c.parent_category_id)
    return c?.name ?? ""
  }
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["title", "categories.id", "product_attributes.cbd_percent", "product_attributes.d9_percent", "product_attributes.thca_percent", "product_attributes.batch_id", "product_attributes.coa_url"],
  })
  const withCoa = (products as any[]).filter((p) => p.product_attributes?.coa_url && p.product_attributes?.d9_percent)
  const pick = [
    ...withCoa.filter((p) => rootOf(p.categories?.[0]?.id) === "Pre-Rolls").slice(0, 2),
    ...withCoa.filter((p) => rootOf(p.categories?.[0]?.id) === "Flower").slice(0, 3),
  ]
  for (const p of pick) {
    const a = p.product_attributes
    const res = await fetch(a.coa_url)
    if (!res.ok) { console.log(`${p.title}: COA fetch ${res.status}`); continue }
    const r = await extractCoa(Buffer.from(await res.arrayBuffer()), "CBD", ["D9", "THC-A"])
    if (!r.ok) { console.log(`${p.title}: ${r.error}`); continue }
    const d = r.data!
    console.log(`${rootOf(p.categories?.[0]?.id)} · ${p.title}`)
    console.log(`  CBD   stored ${a.cbd_percent} · read ${d.thcaPercent}`)
    console.log(`  D9    stored ${a.d9_percent} · read ${d.d9Percent}`)
    console.log(`  THCa  stored ${a.thca_percent} · read ${d.others?.["THC-A"]}`)
    console.log(`  batch stored ${a.batch_id} · read ${d.batchId}${d.notes ? `\n  note: ${d.notes}` : ""}`)
  }
}

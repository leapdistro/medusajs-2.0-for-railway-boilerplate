import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { POST } from "../api/admin/receiving/save/route"
import { loadProfiles, resolveProfileCategories } from "../lib/profile-store"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * Read-only. Phase 4d's "Preview save" runs the save route with
 * `preview: true`. For every category, rebuilds one invoice out of the
 * strains already received (details copied from the stored product)
 * under a made-up invoice number, previews it through the real route,
 * and checks each row comes back restocking its own product, with no
 * detail changes and stock up by exactly its quantity. Then checks
 * nothing was written: stock and receiving history are unchanged.
 *
 *   npx medusa exec ./src/scripts/receiving-preview-check.ts
 */

export default async function receivingPreviewCheck({ container }: { container: any }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)
  const inventory: any = container.resolve(Modules.INVENTORY)
  let bad = 0
  const check = (ok: boolean, what: string) => {
    if (!ok) bad++
    console.log(`  ${ok ? "✓" : "✗"} ${what}`)
  }

  const snapshot = async () => {
    const [, historyCount] = await history.listAndCountReceivingRecords({}, { take: 1 })
    const levels = await inventory.listInventoryLevels({}, { take: 100000 })
    const stock = (levels as any[]).reduce((s, l) => s + Number(l.stocked_quantity ?? 0), 0)
    return { historyCount, levelCount: levels.length, stock }
  }
  const before = await snapshot()

  const records = await history.listReceivingRecords({}, { take: 10000, order: { created_at: "DESC" } })
  const lines = (records as any[]).flatMap((r) => (r.line_results ?? []) as any[])
    .filter((l) => (l.action === "created" || l.action === "restocked") && l.productId)
  const productIds = Array.from(new Set(lines.map((l) => l.productId)))
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title", "categories.id", "product_attributes.*"],
    filters: { id: productIds },
  })
  const byId = new Map((products as any[]).map((p) => [p.id, p]))
  console.log(`${records.length} receiving records, ${lines.length} saved lines, ${productIds.length} products (${byId.size} still in the catalog)`)

  const { profiles } = await loadProfiles(container)
  for (const profile of profiles) {
    /* One row per product (latest line wins), for products sitting in
     * this category's sub-category for the line's tier: the same test
     * the save uses to call a product this strain. */
    const resolved = await resolveProfileCategories(query, profile)
    const subIds: Record<string, string> = {}
    for (const sub of resolved.profile.subcategories) subIds[sub.key] = sub.id
    /* A product moved to another sub-category since it was received
     * (pre-rolls THC-A → CBD) is received under the one it's in now. */
    const rowsByProduct = new Map<string, { line: any; product: any; tier: string }>()
    for (const line of lines) {
      const product = byId.get(line.productId)
      if (!product || rowsByProduct.has(product.id)) continue
      const tier = Object.keys(subIds).find((k) => (product.categories ?? []).some((c: any) => c?.id === subIds[k]))
      if (!tier) continue
      rowsByProduct.set(product.id, { line, product, tier })
    }
    const moved = Array.from(rowsByProduct.values()).filter((r) => r.tier !== r.line.tier).length
    console.log(`\n${profile.key}: ${rowsByProduct.size} product(s)${moved ? `, ${moved} received under another sub-category` : ""}${profile.archived ? " · archived, skipped" : ""}`)
    if (profile.archived) continue
    const mult = profile.inputToPoolMultiplier
    if (rowsByProduct.size > 0) {

    /* Receiving knows a strain by the name it was first saved under
     * (the handle). A product retitled in admin since ("Fruitty
     * Pebbles", handle classic-fruity-pebbles) restocks only under that
     * name, so it's listed rather than previewed. */
    const slug = (t: string) => t.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    const all = Array.from(rowsByProduct.values())
    const renamed = all.filter(({ product }) => !String(product.handle).endsWith(slug(product.title ?? "")))
    for (const { product } of renamed) console.log(`      retitled in admin: "${product.title}" (${product.handle}) restocks only under its original name`)
    const picked = all.filter((r) => !renamed.includes(r))
    const rows = picked.map(({ line, product, tier }, i) => {
      const a = product.product_attributes ?? {}
      return {
        strainName: product.title,
        quantity: i + 1,
        unitPrice: 100,
        sellPrice: profile.pricingModel === "flat" ? 10 : undefined,
        tier,
        strainType: a.strain_type ?? null,
        bestFor: a.best_for ?? null,
        effects: a.effects ?? null,
        coaUrl: a.coa_url ?? "https://example.invalid/preview-check.pdf",
        coaOriginalName: null,
        thcaPercent: a.thca_percent ?? null,
        cbdPercent: a.cbd_percent ?? null,
        cbgPercent: a.cbg_percent ?? null,
        thcpPercent: a.thcp_percent ?? null,
        d9Percent: a.d9_percent ?? null,
        totalCannabinoidsPercent: a.total_cannabinoids_percent ?? null,
        batchId: a.batch_id ?? null,
      }
    })
    const out: any = {}
    const res: any = {
      status(c: number) { out.status = c; return res },
      json(b: any) { out.body = b; out.status ??= 200 },
      setHeader() {},
    }
    await POST({
      scope: container,
      headers: {},
      query: {},
      body: {
        preview: true,
        profileKey: profile.key,
        supplier: { name: "Preview check (not saved)" },
        invoiceNumber: `PREVIEW-CHECK-${Date.now()}`,
        invoiceDate: "2026-10-25",
        shippingTotal: 0,
        rows,
      },
    } as any, res)

    const body = out.body ?? {}
    check(out.status === 200 && body.preview === true, `route answered ${out.status} as a preview (${JSON.stringify(body.summary)})`)
    const results: any[] = body.results ?? []
    const wrong: string[] = []
    let changed = 0
    results.forEach((r, i) => {
      const want = picked[i].product
      const p = r.preview
      if (r.action !== "would-restock") wrong.push(`${rows[i].strainName}: ${r.action}${r.error ? ` (${r.error})` : ""}`)
      else if (r.productId !== want.id) wrong.push(`${rows[i].strainName}: restocks ${r.productHandle}, not ${want.handle}`)
      else if (p.stockAfter - p.stockBefore !== Math.round(rows[i].quantity * mult)) wrong.push(`${rows[i].strainName}: stock ${p.stockBefore} → ${p.stockAfter} for qty ${rows[i].quantity}`)
      if (p?.attributeChanges?.length) {
        changed++
        if (changed <= 3) console.log(`      ${rows[i].strainName} details changing: ${JSON.stringify(p.attributeChanges)}`)
      }
    })
    check(wrong.length === 0, `every row restocks its own product with stock + qty×${mult}${wrong.length ? `:\n      ${wrong.slice(0, 8).join("\n      ")}` : ""}`)
    check(changed === 0, `no details change when the row matches what's stored (${changed} would)`)
    const sample = results.find((r) => r.action === "would-restock")
    if (sample) console.log(`      e.g. ${sample.strainName}: ${sample.productHandle} · ${sample.baseSku} · stock ${sample.preview.stockBefore} → ${sample.preview.stockAfter} · landed ${sample.preview.landedBefore} → ${sample.landedPerQp}`)
    }

    /* A brand-new strain in the same invoice shape comes back as a create. */
    const fresh = {
      strainName: `Preview Check ${Date.now()}`, quantity: 1, unitPrice: 100,
      sellPrice: profile.pricingModel === "flat" ? 10 : undefined,
      tier: Object.keys(subIds)[0], strainType: "Hybrid", bestFor: "evening", effects: [],
      coaUrl: "https://example.invalid/preview-check.pdf", coaOriginalName: null,
      thcaPercent: null, totalCannabinoidsPercent: null,
    }
    const out2: any = {}
    const res2: any = { status(c: number) { out2.status = c; return res2 }, json(b: any) { out2.body = b }, setHeader() {} }
    await POST({ scope: container, headers: {}, query: {}, body: {
      preview: true, profileKey: profile.key, supplier: { name: "Preview check (not saved)" },
      invoiceNumber: `PREVIEW-CHECK-${Date.now()}`, invoiceDate: "2026-10-25", shippingTotal: 0, rows: [fresh],
    } } as any, res2)
    const created = out2.body?.results?.[0]
    check(created?.action === "would-create" && created.preview?.variants?.length > 0 && created.preview.stockAfter === Math.round(mult),
      `a new strain would create: ${created?.productHandle} · ${(created?.preview?.variants ?? []).map((v: any) => `${v.label} ${v.sku} $${v.price}`).join(", ")} · stock ${created?.preview?.stockAfter}${created?.error ? ` (${created.error})` : ""}`)
  }

  const after = await snapshot()
  console.log("\nNothing written:")
  check(after.historyCount === before.historyCount, `receiving history records ${before.historyCount} → ${after.historyCount}`)
  check(after.levelCount === before.levelCount && after.stock === before.stock, `stock levels ${before.levelCount} → ${after.levelCount}, total stock ${before.stock} → ${after.stock}`)

  console.log(bad === 0 ? "\nRESULT: preview matches, nothing written." : `\nRESULT: ${bad} problem(s), see ✗ above.`)
}

/**
 * Receiving templates + automatic receiving drafts (lib/marketing/campaigns.ts).
 * Run like marketing.test.ts.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyTemplate, fillTokens, productsPhrase, sendProblems, upsertReceivingDraft } from "../campaigns"
import { sanitizeBlocks } from "../blocks"

describe("receiving words", () => {
  it("fill in counts", () => {
    assert.equal(productsPhrase(23, 9), "23 new products")
    assert.equal(productsPhrase(1, 0), "1 new product")
    assert.equal(productsPhrase(0, 9), "9 products back in stock")
    assert.equal(fillTokens("Just landed: {{products}} ({{ new_count }}/{{restock_count}})", { newCount: 3, restockCount: 2 }), "Just landed: 3 new products (3/2)")
  })
  it("a campaign can't go out with unfilled receiving words or fill blocks", () => {
    const blocks = sanitizeBlocks([{ type: "heading", text: "Hi" }, { type: "products", productIds: [], fill: "new" }])
    const p = sendProblems({ subject: "Just landed: {{products}}", blocks })
    assert.equal(p.length, 2)
  })
  it("templates without a receiving keep fill blocks as empty picks", () => {
    const out = applyTemplate(sanitizeBlocks([{ type: "products", productIds: ["prod_ABCDEF1"], fill: "new", max: 3 }]), null, null)
    assert.equal((out[0] as any).fill, undefined)
    assert.deepEqual((out[0] as any).productIds, [])
  })
})

/* ───────── fake world for upsertReceivingDraft ───────── */
function world(lines: any[], products: Record<string, { stock: number; tier: string; image?: boolean }>, template?: any) {
  const campaigns: any[] = template ? [template] : []
  let n = 0
  const match = (r: any, f: any) => Object.entries(f).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))
  const marketing = {
    listMarketingCampaigns: async (f: any, o: any = {}) => campaigns.filter((c) => match(c, f)).slice(0, o.take ?? 1e9),
    createMarketingCampaigns: async (d: any) => { const c = { id: `mcam_${++n}`, ...d }; campaigns.push(c); return c },
    updateMarketingCampaigns: async (p: any) => { const c = campaigns.find((x) => x.id === p.id); Object.assign(c, p); return c },
  }
  const record = { id: "rr_1", invoice_number: "INV-1", invoice_date: "2026-11-25", line_results: lines }
  const history = { retrieveReceivingRecord: async (id: string) => (id === "rr_1" ? record : Promise.reject(new Error("nf"))) }
  const tiers: Record<string, any> = {
    cat_classic: { id: "cat_classic", name: "Classic", handle: "classic", parent_category_id: "cat_flower", metadata: { accent: "tier-classic", tier_key: "classic" } },
    cat_super: { id: "cat_super", name: "Super", handle: "super", parent_category_id: "cat_flower", metadata: { accent: "tier-super", tier_key: "super" } },
    cat_flower: { id: "cat_flower", name: "Flower", handle: "flower", parent_category_id: null, metadata: {} },
  }
  const query = {
    graph: async ({ entity, filters }: any) => {
      if (entity === "product_category") return { data: Object.values(tiers) }
      const ids: string[] = filters.id
      return {
        data: ids.filter((id) => products[id]).map((id) => ({
          id, title: id, handle: id, status: "published", thumbnail: products[id].image === false ? null : `https://x/${id}.jpg`, images: [],
          categories: [{ id: products[id].tier, handle: tiers[products[id].tier].handle }],
          collection: null,
          variants: [{ id: `v_${id}`, title: "QP", manage_inventory: true, calculated_price: { calculated_amount: 300 },
            inventory_items: [{ required_quantity: 1, inventory: { location_levels: [{ stocked_quantity: products[id].stock, reserved_quantity: 0 }] } }] }],
        })),
      }
    },
  }
  const services: Record<string, any> = { marketing, receiving_history: history, query }
  return { scope: { resolve: (k: string) => services[k] }, campaigns }
}

describe("automatic receiving draft", () => {
  const lines = [
    ...Array.from({ length: 30 }, (_, i) => ({ productId: `prod_new${String(i).padStart(3, "0")}`, action: "created" })),
    ...Array.from({ length: 6 }, (_, i) => ({ productId: `prod_old${String(i).padStart(3, "0")}`, action: "restocked" })),
  ]
  const products: Record<string, any> = {}
  lines.forEach((l, i) => { products[l.productId] = { stock: i % 7 === 0 ? 0 : 5, tier: i % 3 ? "cat_classic" : "cat_super" } })

  it("built-in wording: 8 new + 4 restocked, counts filled, one draft per receiving", async () => {
    const w = world(lines, products)
    const r: any = await upsertReceivingDraft(w.scope, "rr_1", { auto: true })
    assert.equal(r.created, true)
    const c = r.campaign
    const blocks = c.blocks.filter((b: any) => b.type === "products")
    assert.equal(blocks[0].productIds.length, 8)
    assert.equal(blocks[1].productIds.length, 4)
    assert.equal(c.source.newTotal, 25) /* 30 new minus the sold-out ones */
    assert.match(c.subject, /^Just landed: 25 new products$/)
    assert.ok(!JSON.stringify(c.blocks).includes("{{products}}"))
    assert.equal(c.source.auto, true)
    /* Second save of the same receiving refreshes, doesn't duplicate. */
    const again: any = await upsertReceivingDraft(w.scope, "rr_1", { auto: true })
    assert.equal(again.created, false)
    assert.equal(again.refreshed, true)
    assert.equal(w.campaigns.length, 1)
  })

  it("an edited draft is never overwritten", async () => {
    const w = world(lines, products)
    const r: any = await upsertReceivingDraft(w.scope, "rr_1", { auto: true })
    r.campaign.source.edited = true
    r.campaign.subject = "My own subject"
    const again: any = await upsertReceivingDraft(w.scope, "rr_1", { auto: true })
    assert.equal(again.refreshed, false)
    assert.equal(w.campaigns[0].subject, "My own subject")
  })

  it("uses the template marked for receivings", async () => {
    const template = {
      id: "mcam_t", status: "template", template_role: "receiving", name: "Mine",
      subject: "{{new_count}} fresh strains", preheader: "", audience: { mode: "filter", pricingModes: ["tier_2"] },
      blocks: [{ id: "h", type: "heading", text: "Hello" }, { id: "p", type: "products", productIds: [], fill: "new", max: 4, layout: "list", showPrices: false }],
    }
    const w = world(lines, products, template)
    const r: any = await upsertReceivingDraft(w.scope, "rr_1", { auto: true })
    const c = r.campaign
    assert.equal(c.subject, "25 fresh strains")
    assert.equal(c.audience.mode, "filter")
    const pb = c.blocks.find((b: any) => b.type === "products")
    assert.equal(pb.productIds.length, 4)
    assert.equal(pb.layout, "list")
    assert.equal(pb.fill, undefined)
    assert.equal(c.source.templateId, "mcam_t")
  })

  it("restock-only receiving reads right; nothing live = no draft", async () => {
    const only = lines.filter((l) => l.action === "restocked")
    const w = world(only, products)
    const r: any = await upsertReceivingDraft(w.scope, "rr_1", { auto: true })
    assert.match(r.campaign.subject, /products back in stock/)
    const dead: Record<string, any> = {}
    for (const k of Object.keys(products)) dead[k] = { ...products[k], stock: 0 }
    const w2 = world(lines, dead)
    const r2: any = await upsertReceivingDraft(w2.scope, "rr_1", { auto: true })
    assert.equal(r2.campaign, null)
    assert.equal(w2.campaigns.length, 0)
  })
})

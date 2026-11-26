/**
 * Tests for lib/marketing (blocks, audience, unsubscribe tokens, featured
 * picks, the send queue). node:test with a fake container, run like
 * lib/__tests__/account-link.test.ts: esbuild-bundle with
 * `@medusajs/framework/utils` aliased to a stub exporting Modules,
 * ContainerRegistrationKeys (+ PG_CONNECTION, QUERY) and QueryContext,
 * `--jsx=automatic --external:resend`, then `NODE_PATH=node_modules node --test`.
 */
import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import { matchesAudience, type Contact } from "../audience"
import { sanitizeAudience, sanitizeBlocks } from "../blocks"
import { pickFeatured } from "../campaigns"
import { personalize, trackedUrl } from "../email"
import { processCampaign, queueCampaign } from "../send"
import { setMarketingSenderForTests, type OutgoingEmail } from "../sender"
import { readUnsubscribeToken, unsubscribeToken } from "../unsubscribe"

beforeEach(() => {
  process.env.JWT_SECRET = "test-secret"
  process.env.STOREFRONT_URL = "https://www.hempmbs.com"
  process.env.MARKETING_FROM_EMAIL = "MBS <hello@news.hempmbs.com>"
})

describe("blocks", () => {
  it("drops unknown blocks and unsafe links, keeps good ones", () => {
    const b = sanitizeBlocks([
      { type: "heading", text: "Hi", highlight: "Hi" },
      { type: "script", text: "x" },
      { type: "button", label: "Go", url: "javascript:alert(1)" },
      { type: "button", label: "Go", url: "/products" },
      { type: "products", productIds: ["prod_ABC123", "nope", "prod_ABC123"], layout: "weird" },
    ])
    assert.equal(b.length, 4)
    assert.equal((b[1] as any).url, "")
    assert.equal((b[2] as any).url, "/products")
    assert.deepEqual((b[3] as any).productIds, ["prod_ABC123"])
    assert.equal((b[3] as any).layout, "grid")
  })
  it("fills names and tags only our own links", () => {
    assert.equal(personalize("Hi {{first_name}} at {{ company }}", { firstName: "Sam", company: "" }), "Hi Sam at your store")
    assert.match(trackedUrl("/products?sort=new", "mcam_1"), /^https:\/\/www\.hempmbs\.com\/products\?sort=new&utm_source=mbs-email&utm_medium=email&utm_campaign=mcam_1$/)
    assert.equal(trackedUrl("https://example.com/a", "mcam_1"), "https://example.com/a")
  })
})

const contact = (o: Partial<Contact>): Contact => ({
  customerId: "cus_1", email: "a@x.com", firstName: "", lastName: "", company: "", groupIds: [],
  pricingMode: "default", state: "TX", businessType: "Smoke shop", ...o,
})

describe("audience", () => {
  it("filter, pick and exclude", () => {
    const a = sanitizeAudience({ mode: "filter", pricingModes: ["tier_2"], states: ["tx"] })
    assert.equal(matchesAudience(contact({ pricingMode: "tier_2" }), a), true)
    assert.equal(matchesAudience(contact({ pricingMode: "default" }), a), false)
    assert.equal(matchesAudience(contact({ pricingMode: "tier_2", state: "OK" }), a), false)
    const p = sanitizeAudience({ mode: "pick", customerIds: ["cus_2"] })
    assert.equal(matchesAudience(contact({}), p), false)
    assert.equal(matchesAudience(contact({ customerId: "cus_2" }), p), true)
    const all = sanitizeAudience({ mode: "all", exclude: ["cus_1"] })
    assert.equal(matchesAudience(contact({}), all), false)
  })
})

describe("unsubscribe tokens", () => {
  it("round-trips and rejects tampering", () => {
    const t = unsubscribeToken("Buyer@Shop.com", "mcam_9")!
    assert.deepEqual(readUnsubscribeToken(t), { email: "buyer@shop.com", campaignId: "mcam_9" })
    const [e, c, s] = t.split(".")
    const other = Buffer.from("victim@shop.com").toString("base64url")
    assert.equal(readUnsubscribeToken(`${other}.${c}.${s}`), null)
    assert.equal(readUnsubscribeToken(`${e}.${c}.${s.slice(0, -1)}x`), null)
    assert.equal(readUnsubscribeToken("junk"), null)
  })
})

describe("featured picks for a big receiving", () => {
  it("keeps 8, live only, photos first, spread across tiers", () => {
    const cards = new Map<string, any>()
    const ids: string[] = []
    for (let i = 0; i < 100; i++) {
      const id = `prod_${String(i).padStart(6, "0")}`
      ids.push(id)
      cards.set(id, { inStock: i % 10 !== 0, image: i % 3 ? "img" : null, badge: i < 70 ? "Classic" : i < 90 ? "Super" : "Rapper" })
    }
    const picked = pickFeatured(ids, cards, 8)
    assert.equal(picked.length, 8)
    assert.ok(picked.every((id) => cards.get(id).inStock))
    assert.ok(picked.every((id) => cards.get(id).image))
    const tiers = new Set(picked.map((id) => cards.get(id).badge))
    assert.deepEqual([...tiers].sort(), ["Classic", "Rapper", "Super"])
  })
})

/* ───────── send queue with a fake container ───────── */

function fakeWorld(nCustomers: number) {
  const campaigns = new Map<string, any>()
  const recipients: any[] = []
  const suppressions: any[] = []
  let n = 0
  const now = () => new Date().toISOString()
  const match = (r: any, f: any) => Object.entries(f).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))
  const marketing = {
    retrieveMarketingCampaign: async (id: string) => ({ ...campaigns.get(id) }),
    listMarketingCampaigns: async (f: any) => [...campaigns.values()].filter((c) => match(c, f)),
    updateMarketingCampaigns: async (p: any) => { const c = { ...campaigns.get(p.id), ...p }; campaigns.set(p.id, c); return c },
    listMarketingRecipients: async (f: any, o: any = {}) => recipients.filter((r) => match(r, f)).slice(0, o.take ?? 1e9).map((r) => ({ ...r })),
    createMarketingRecipients: async (rows: any[]) => {
      for (const r of rows) {
        if (recipients.some((x) => x.campaign_id === r.campaign_id && x.email === r.email)) throw new Error("unique violation")
        recipients.push({ id: `mrec_${++n}`, updated_at: now(), ...r })
      }
    },
    updateMarketingRecipients: async (rows: any[]) => {
      for (const p of rows) Object.assign(recipients.find((r) => r.id === p.id), p, { updated_at: now() })
    },
    listMarketingSuppressions: async () => suppressions.map((s) => ({ ...s })),
  }
  const approved = { id: "cusgrp_approved", name: "approved" }
  const customers = Array.from({ length: nCustomers }, (_, i) => ({
    id: `cus_${i}`, email: `buyer${i}@shop.com`, first_name: `B${i}`, company_name: `Shop ${i}`,
    metadata: { pricing_mode: "default", state: "TX" }, groups: [approved],
  }))
  customers.push({ id: "cus_pending", email: "pending@shop.com", first_name: "P", company_name: "P", metadata: {}, groups: [] } as any)
  const customer = {
    listCustomerGroups: async () => [approved],
    listCustomers: async (_f: any, o: any) => customers.slice(o.skip ?? 0, (o.skip ?? 0) + (o.take ?? 1e9)),
  }
  let lockedUntil: string | null = null
  const pg = {
    raw: async (sql: string, params: any[]) => {
      if (sql.includes("returning id")) {
        if (lockedUntil && lockedUntil >= params[2]) return { rows: [] }
        lockedUntil = params[0]; return { rows: [{ id: params[1] }] }
      }
      if (sql.includes("locked_until = null")) { lockedUntil = null; return { rows: [] } }
      lockedUntil = params[0]; return { rows: [] }
    },
  }
  const services: Record<string, any> = { marketing, customer, pg_connection: pg, PG_CONNECTION: pg, logger: console }
  const scope = { resolve: (k: string) => services[k] ?? services[String(k).toLowerCase()] }
  const logs: string[] = []
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }
  campaigns.set("mcam_1", {
    id: "mcam_1", name: "T", subject: "Hello", preheader: "", status: "draft", sent_count: 0, failed_count: 0,
    blocks: [{ id: "h", type: "heading", text: "Hi {{first_name}}" }],
    audience: { mode: "all" },
  })
  return { scope, campaigns, recipients, suppressions, log, logs }
}

function fakeSender(fail?: (e: OutgoingEmail) => string | null) {
  const sent: OutgoingEmail[] = []
  setMarketingSenderForTests({
    maxBatch: 100, pauseMs: 0,
    sendBatch: async (emails) => emails.map((e) => {
      const err = fail?.(e) ?? null
      if (!err) sent.push(e)
      return { id: err ? null : `re_${sent.length}`, error: err }
    }),
  })
  return sent
}

describe("send queue", () => {
  it("sends each approved, non-suppressed buyer exactly once, personalised, with one-click unsubscribe", async () => {
    const w = fakeWorld(250)
    w.suppressions.push({ email: "buyer7@shop.com", reason: "unsubscribed" })
    const sent = fakeSender()
    const q = await queueCampaign(w.scope, "mcam_1")
    assert.equal(q.queued, 249)
    assert.equal(q.suppressed, 1)
    await processCampaign(w.scope, "mcam_1", w.log)
    assert.equal(sent.length, 249)
    assert.equal(new Set(sent.map((e) => e.to)).size, 249)
    assert.ok(!sent.some((e) => e.to === "buyer7@shop.com" || e.to === "pending@shop.com"))
    assert.match(sent[0].html, /Hi B0/)
    assert.match(sent[0].headers!["List-Unsubscribe"], /^<https:\/\/www\.hempmbs\.com\/api\/unsubscribe\?t=/)
    assert.equal(sent[0].headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")
    const c = w.campaigns.get("mcam_1")
    assert.equal(c.status, "sent")
    assert.equal(c.sent_count, 249)
    /* Queuing or processing again sends nothing new. */
    await queueCampaign(w.scope, "mcam_1")
    w.campaigns.get("mcam_1").status = "sending"
    await processCampaign(w.scope, "mcam_1", w.log)
    assert.equal(sent.length, 249)
  })

  it("someone who unsubscribes mid-send is skipped", async () => {
    const w = fakeWorld(150)
    const sent = fakeSender()
    await queueCampaign(w.scope, "mcam_1")
    w.suppressions.push({ email: "buyer140@shop.com", reason: "unsubscribed" })
    await processCampaign(w.scope, "mcam_1", w.log)
    assert.equal(sent.length, 149)
    assert.equal(w.recipients.find((r) => r.email === "buyer140@shop.com").status, "skipped")
  })

  it("a crash mid-batch never re-sends: stale claims are marked failed", async () => {
    const w = fakeWorld(3)
    const sent = fakeSender()
    await queueCampaign(w.scope, "mcam_1")
    const r0 = w.recipients[0]
    r0.status = "sending"
    r0.updated_at = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    await processCampaign(w.scope, "mcam_1", w.log)
    assert.equal(sent.length, 2)
    assert.equal(w.recipients[0].status, "failed")
    assert.ok(!sent.some((e) => e.to === r0.email))
  })

  it("stops when a whole batch fails instead of burning the list", async () => {
    const w = fakeWorld(250)
    const sent = fakeSender(() => "validation_error: domain not verified")
    await queueCampaign(w.scope, "mcam_1")
    await processCampaign(w.scope, "mcam_1", w.log)
    const c = w.campaigns.get("mcam_1")
    assert.equal(c.status, "failed")
    assert.match(c.last_error, /domain not verified/)
    assert.equal(sent.length, 0)
    assert.equal(w.recipients.filter((r) => r.status === "failed").length, 100)
    assert.equal(w.recipients.filter((r) => r.status === "queued").length, 150)
  })

  it("Stop (cancel) mid-send leaves the rest unsent", async () => {
    const w = fakeWorld(250)
    let calls = 0
    setMarketingSenderForTests({
      maxBatch: 100, pauseMs: 0,
      sendBatch: async (emails) => {
        calls++
        if (calls === 1) w.campaigns.get("mcam_1").status = "cancelled"
        return emails.map((_, i) => ({ id: `re_${calls}_${i}`, error: null }))
      },
    })
    await queueCampaign(w.scope, "mcam_1")
    await processCampaign(w.scope, "mcam_1", w.log)
    assert.equal(calls, 1)
    assert.equal(w.recipients.filter((r) => r.status === "sent").length, 100)
  })
})

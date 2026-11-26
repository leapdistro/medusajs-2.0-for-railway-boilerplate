import { EMPTY_AUDIENCE, sanitizeAudience, sanitizeBlocks, type Block } from "./blocks"
import { senderStatus } from "./sender"
import { loadEmailProducts, type EmailProduct } from "./products"

const uid = () => Math.random().toString(36).slice(2, 10)

/** A new campaign's starting content: one of each common block. */
export function starterBlocks(): Block[] {
  return [
    { id: uid(), type: "heading", text: "Just landed.", highlight: "landed" },
    { id: uid(), type: "text", text: "Hi {{first_name}},\n\nFresh from our latest delivery and ready to ship next day." },
    { id: uid(), type: "products", title: "New this week", productIds: [], layout: "grid", showPrices: true },
    { id: uid(), type: "button", label: "Shop new arrivals", url: "/products" },
  ]
}

/** How many products an announcement features before "See all". */
export const FEATURE_NEW = 8
export const FEATURE_RESTOCK = 4

/**
 * Picks which of a receiving's products to feature: only ones that are
 * live and in stock, ones with a photo first, then round-robin across
 * tiers / brands (in receiving order) so a big delivery shows its range
 * rather than the first eight lines of one tier.
 */
export function pickFeatured(ids: string[], cards: Map<string, EmailProduct>, max: number): string[] {
  const live = ids.filter((id) => cards.get(id)?.inStock)
  const ordered = [...live.filter((id) => cards.get(id)?.image), ...live.filter((id) => !cards.get(id)?.image)]
  const groups = new Map<string, string[]>()
  for (const id of ordered) {
    const k = cards.get(id)?.badge || "-"
    groups.set(k, [...(groups.get(k) ?? []), id])
  }
  const out: string[] = []
  const queues = [...groups.values()]
  while (out.length < max && queues.some((q) => q.length)) {
    for (const q of queues) {
      const next = q.shift()
      if (next) out.push(next)
      if (out.length >= max) break
    }
  }
  return out
}

/**
 * Draft for "Announce this receiving". A delivery of 100 products
 * features up to 8 new ones (+ up to 4 restocks), varied across tiers,
 * and a button to the full list on the site (New Arrivals sort). The
 * admin can swap any of them in the editor.
 */
export async function receivingDraft(scope: any, record: any): Promise<{ name: string; subject: string; blocks: Block[]; counts: { newTotal: number; restockTotal: number; featuredNew: number; featuredRestock: number } }> {
  const lines = (Array.isArray(record?.line_results) ? record.line_results : []) as any[]
  const ok = lines.filter((l) => l?.productId && (l.action === "created" || l.action === "restocked"))
  const created = [...new Set(ok.filter((l) => l.action === "created").map((l) => String(l.productId)))]
  const restocked = [...new Set(ok.filter((l) => l.action === "restocked").map((l) => String(l.productId)))].filter((id) => !created.includes(id))

  const cards = await loadEmailProducts(scope, [...created, ...restocked], [], { includeUnavailable: true })
  const liveNew = created.filter((id) => cards.get(id)?.inStock)
  const liveRestock = restocked.filter((id) => cards.get(id)?.inStock)
  const featuredNew = pickFeatured(created, cards, FEATURE_NEW)
  const featuredRestock = pickFeatured(restocked, cards, liveNew.length ? FEATURE_RESTOCK : FEATURE_NEW)

  const blocks: Block[] = [
    { id: uid(), type: "heading", text: liveNew.length ? "Fresh drop just landed." : "Back in stock.", highlight: liveNew.length ? "landed" : "stock" },
    { id: uid(), type: "text", text: "Hi {{first_name}},\n\nOur latest delivery is in and ready to ship next day." +
      (liveNew.length > featuredNew.length ? ` Here are a few of the ${liveNew.length} new products.` : " Here's what's new.") },
  ]
  if (featuredNew.length) blocks.push({ id: uid(), type: "products", title: "New arrivals", productIds: featuredNew, layout: "grid", showPrices: true })
  if (featuredRestock.length) blocks.push({ id: uid(), type: "products", title: "Back in stock", productIds: featuredRestock, layout: "grid", showPrices: true })
  const total = liveNew.length + liveRestock.length
  const featured = featuredNew.length + featuredRestock.length
  blocks.push({
    id: uid(), type: "button",
    label: total > featured ? `See all ${liveNew.length || total} ${liveNew.length ? "new products" : "products"}` : "Shop the drop",
    url: "/products?sort=new",
  })
  const date = String(record?.invoice_date ?? "").slice(0, 10)
  return {
    name: `New arrivals ${date || new Date().toISOString().slice(0, 10)}`,
    subject: liveNew.length ? `Just landed: ${liveNew.length} new product${liveNew.length === 1 ? "" : "s"}` : "Back in stock this week",
    blocks,
    counts: { newTotal: liveNew.length, restockTotal: liveRestock.length, featuredNew: featuredNew.length, featuredRestock: featuredRestock.length },
  }
}

export function serializeCampaign(c: any) {
  return {
    id: c.id,
    name: c.name,
    subject: c.subject,
    preheader: c.preheader,
    blocks: sanitizeBlocks(c.blocks),
    audience: sanitizeAudience(c.audience ?? EMPTY_AUDIENCE),
    status: c.status,
    scheduled_at: c.scheduled_at,
    started_at: c.started_at,
    sent_at: c.sent_at,
    recipient_count: c.recipient_count,
    sent_count: c.sent_count,
    failed_count: c.failed_count,
    last_error: c.last_error,
    source: c.source,
    last_test_at: c.last_test_at,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }
}

export const sendingSetup = () => senderStatus()

/** What can't be sent yet, in words; [] when ready. */
export function sendProblems(c: { subject: string; blocks: Block[] }): string[] {
  const out: string[] = []
  if (!c.subject.trim()) out.push("Add a subject line.")
  if (!c.blocks.some((b) => (b.type === "heading" || b.type === "text") && b.text.trim())) out.push("Add a heading or some text.")
  if (c.blocks.some((b) => b.type === "button" && b.label.trim() && !b.url)) out.push("A button has no link.")
  if (c.blocks.some((b) => b.type === "image" && !b.url)) out.push("An image block has no picture.")
  return out
}

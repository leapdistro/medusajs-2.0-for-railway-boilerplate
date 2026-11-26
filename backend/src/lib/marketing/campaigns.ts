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

/* ───────── Templates ───────── */

/** Receiving words a template can use; filled when the draft is made. */
export const RECEIVING_TOKENS = ["{{products}}", "{{new_count}}", "{{restock_count}}"]
const TOKEN_RE = /\{\{\s*(products|new_count|restock_count)\s*\}\}/gi

/**
 * Used when no saved template is marked for receivings. Same content as
 * before templates existed; "Save as template" on a draft made from it
 * is the easy way to start customising.
 */
export function builtinReceivingTemplate() {
  return {
    id: null as string | null,
    name: "Receiving announcement (built in)",
    subject: "Just landed: {{products}}",
    preheader: "Ready to ship next day. Lab reports on every batch.",
    audience: EMPTY_AUDIENCE,
    blocks: [
      { id: uid(), type: "heading", text: "Fresh drop just landed.", highlight: "landed" },
      { id: uid(), type: "text", text: "Hi {{first_name}},\n\nOur latest delivery is in and ready to ship next day. Here's a first look at {{products}}." },
      { id: uid(), type: "products", title: "New arrivals", productIds: [], layout: "grid", showPrices: true, fill: "new", max: 8 },
      { id: uid(), type: "products", title: "Back in stock", productIds: [], layout: "grid", showPrices: true, fill: "restock", max: 4 },
      { id: uid(), type: "button", label: "Shop new arrivals", url: "/products?sort=new" },
    ] as Block[],
  }
}

/** The saved template marked for receivings, else the built-in one. */
export async function receivingTemplate(scope: any) {
  const marketing: any = scope.resolve("marketing")
  const rows = (await marketing.listMarketingCampaigns(
    { status: "template", template_role: "receiving" },
    { take: 1, order: { updated_at: "DESC" } },
  )) as any[]
  const t = rows[0]
  if (!t) return builtinReceivingTemplate()
  return { id: t.id as string | null, name: t.name, subject: t.subject, preheader: t.preheader, audience: t.audience ?? EMPTY_AUDIENCE, blocks: sanitizeBlocks(t.blocks) }
}

/** "23 new products" / "9 products back in stock" / "1 new product". */
export function productsPhrase(newCount: number, restockCount: number): string {
  if (newCount) return `${newCount} new product${newCount === 1 ? "" : "s"}`
  return `${restockCount} product${restockCount === 1 ? "" : "s"} back in stock`
}

export function fillTokens(text: string, counts: { newCount: number; restockCount: number }): string {
  return text.replace(TOKEN_RE, (_, k: string) => {
    const key = k.toLowerCase()
    if (key === "new_count") return String(counts.newCount)
    if (key === "restock_count") return String(counts.restockCount)
    return productsPhrase(counts.newCount, counts.restockCount)
  })
}

/** Fill-from-receiving products blocks become plain picks (or go). */
export function applyTemplate(
  blocks: Block[],
  picks: { new: string[]; restock: string[] } | null,
  counts: { newCount: number; restockCount: number } | null,
): Block[] {
  const out: Block[] = []
  for (const b of blocks) {
    const copy: any = { ...b, id: uid() }
    if (b.type === "products" && b.fill) {
      const ids = picks ? picks[b.fill].slice(0, b.max ?? 8) : []
      if (picks && !ids.length) continue
      delete copy.fill
      delete copy.max
      copy.productIds = ids
    }
    if (counts) {
      if (b.type === "heading" || b.type === "text") copy.text = fillTokens(copy.text, counts)
      if (b.type === "button") copy.label = fillTokens(copy.label, counts)
      if (b.type === "products" && copy.title) copy.title = fillTokens(copy.title, counts)
    }
    out.push(copy)
  }
  return out
}

/**
 * Draft for "Announce this receiving", from the receiving template.
 * A delivery of 100 products features up to each block's max (8 new +
 * 4 restocked in the built-in one), live and in stock only, photos
 * first, varied across tiers / brands. Returns null when nothing in the
 * receiving is live and in stock.
 */
export async function receivingDraft(scope: any, record: any) {
  const lines = (Array.isArray(record?.line_results) ? record.line_results : []) as any[]
  const ok = lines.filter((l) => l?.productId && (l.action === "created" || l.action === "restocked"))
  const created = [...new Set(ok.filter((l) => l.action === "created").map((l) => String(l.productId)))]
  const restocked = [...new Set(ok.filter((l) => l.action === "restocked").map((l) => String(l.productId)))].filter((id) => !created.includes(id))

  const cards = await loadEmailProducts(scope, [...created, ...restocked], [], { includeUnavailable: true })
  const liveNew = created.filter((id) => cards.get(id)?.inStock)
  const liveRestock = restocked.filter((id) => cards.get(id)?.inStock)
  if (!liveNew.length && !liveRestock.length) return null

  const template = await receivingTemplate(scope)
  const maxOf = (fill: "new" | "restock") =>
    Math.max(0, ...template.blocks.map((b) => (b.type === "products" && b.fill === fill ? b.max ?? 8 : 0)))
  const picks = {
    new: pickFeatured(created, cards, maxOf("new") || FEATURE_NEW),
    /* No new products: a restock block may show as many as a new one would. */
    restock: pickFeatured(restocked, cards, liveNew.length ? maxOf("restock") || FEATURE_RESTOCK : Math.max(maxOf("new"), maxOf("restock"), FEATURE_NEW)),
  }
  const counts = { newCount: liveNew.length, restockCount: liveRestock.length }
  let blocks = applyTemplate(template.blocks, picks, counts)
  /* Template without fill blocks: add the products so the email isn't empty. */
  if (!blocks.some((b) => b.type === "products" && b.productIds.length)) {
    const ids = picks.new.length ? picks.new : picks.restock
    const at = blocks.findIndex((b) => b.type === "button")
    const block: Block = { id: uid(), type: "products", title: picks.new.length ? "New arrivals" : "Back in stock", productIds: ids, layout: "grid", showPrices: true }
    blocks = at >= 0 ? [...blocks.slice(0, at), block, ...blocks.slice(at)] : [...blocks, block]
  }
  const featuredNew = blocks.filter((b) => b.type === "products").flatMap((b: any) => b.productIds).filter((id: string) => liveNew.includes(id)).length
  const featuredRestock = blocks.filter((b) => b.type === "products").flatMap((b: any) => b.productIds).filter((id: string) => liveRestock.includes(id)).length
  const date = String(record?.invoice_date ?? "").slice(0, 10)
  return {
    name: `New arrivals ${date || new Date().toISOString().slice(0, 10)}`,
    subject: fillTokens(template.subject || "Just landed: {{products}}", counts),
    preheader: fillTokens(template.preheader ?? "", counts),
    audience: template.audience,
    blocks,
    templateId: template.id,
    counts: { newTotal: liveNew.length, restockTotal: liveRestock.length, featuredNew, featuredRestock },
  }
}

/**
 * Makes (or refreshes) the announcement draft for one receiving. One
 * draft per receiving: a second save under the same invoice refreshes
 * the draft unless the admin has already edited it. Used by the
 * Announce button and the receiving.saved subscriber.
 */
export async function upsertReceivingDraft(scope: any, historyId: string, opts: { auto: boolean; actorId?: string | null }) {
  const marketing: any = scope.resolve("marketing")
  const history: any = scope.resolve("receiving_history")
  const record = await history.retrieveReceivingRecord(historyId).catch(() => null)
  if (!record) return { campaign: null, reason: "Receiving not found." }
  const existing = ((await marketing.listMarketingCampaigns({}, { take: 500, order: { created_at: "DESC" } })) as any[])
    .find((c) => c.source?.type === "receiving" && c.source?.id === historyId && c.status !== "template")
  if (existing && (existing.status !== "draft" || existing.source?.edited)) return { campaign: existing, created: false, refreshed: false }

  const draft = await receivingDraft(scope, record)
  if (!draft) return { campaign: existing ?? null, reason: "None of this receiving's products are live and in stock right now, so there's nothing to announce." }
  const source = {
    type: "receiving", id: record.id, invoice: record.invoice_number ?? null, templateId: draft.templateId,
    auto: existing?.source?.auto ?? opts.auto, ...draft.counts,
  }
  const fields = { name: draft.name, subject: draft.subject, preheader: draft.preheader, blocks: draft.blocks, audience: draft.audience, source }
  if (existing) {
    const updated = await marketing.updateMarketingCampaigns({ id: existing.id, ...fields })
    return { campaign: updated, created: false, refreshed: true }
  }
  const created = await marketing.createMarketingCampaigns({ ...fields, status: "draft", created_by: opts.actorId ?? null })
  return { campaign: created, created: true, refreshed: false }
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
    template_role: c.template_role ?? null,
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
  const words = [c.subject, ...c.blocks.map((b: any) => `${b.text ?? ""} ${b.label ?? ""} ${b.title ?? ""}`)].join(" ")
  if (/\{\{\s*(products|new_count|restock_count)\s*\}\}/i.test(words)) out.push("Replace the receiving words ({{products}}, {{new_count}}, {{restock_count}}); they only fill in for receiving announcements.")
  if (c.blocks.some((b) => b.type === "products" && b.fill)) out.push("A products block is set to fill from a receiving; pick its products instead.")
  return out
}

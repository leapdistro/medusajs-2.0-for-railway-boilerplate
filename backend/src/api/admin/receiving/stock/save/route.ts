import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  acquireInflightLock,
  getIdempotentResponse,
  releaseInflightLock,
  setIdempotentResponse,
} from "../../../../../lib/idempotency"
import { findProfile } from "../../../../../lib/profile-store"
import {
  buildStockContext,
  checkNewProduct,
  createProduct,
  duplicateRestocks,
  itemName,
  loadItems,
  restockItem,
  type NewProductIn,
  type RestockIn,
  type StockLineResult,
} from "../../../../../lib/stock-receive"
import type { ShippingRates } from "../../../../../lib/shipping-rates"
import { MBS_SETTINGS_MODULE } from "../../../../../modules/mbs-settings"
import { RECEIVING_HISTORY_MODULE } from "../../../../../modules/receiving-history"
import { RECEIVING_DRAFTS_MODULE } from "../../../../../modules/receiving-drafts"

/**
 * POST /admin/receiving/stock/save — the Receive stock screen
 * (lib/stock-receive.ts) for resold brands.
 *
 * Body: { profileKey, supplier, invoiceNumber, invoiceDate, freight,
 *   total, restocks: RestockIn[], products: NewProductIn[], freeStock?,
 *   draftId? }
 *
 * Same contract as /admin/receiving/save: everything is checked before
 * anything is written; lines this invoice + supplier already saved are
 * skipped ("already-saved"), so saving again after a failure doesn't add
 * stock twice; one receiving-history record per invoice + supplier; the
 * receiving.saved event refreshes Owner Stores prices; an
 * Idempotency-Key header replays a repeated request.
 */

type Body = {
  profileKey?: string
  supplier?: { name?: string; phone?: string | null; email?: string | null; address?: string | null; qboVendorId?: string | null }
  invoiceNumber?: string
  invoiceDate?: string
  freight?: number
  total?: number
  restocks?: RestockIn[]
  products?: NewProductIn[]
  freeStock?: boolean
  draftId?: string | null
}

const IDEMPOTENCY_NS = "receiving-stock-save"
const normName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase()
const lineKey = (name: unknown, tier: unknown) => `${normName(name)}|${String(tier ?? "")}`
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

async function inPool<T>(items: T[], fn: (item: T) => Promise<void>, size = 6) {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) await fn(items[cursor++])
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const idemKey = String(req.headers["idempotency-key"] ?? "").trim() || null
  if (idemKey) {
    const cached = await getIdempotentResponse(IDEMPOTENCY_NS, idemKey)
    if (cached) {
      res.setHeader("Idempotent-Replayed", "true")
      res.status(cached.status).json(cached.body)
      return
    }
    if (!(await acquireInflightLock(IDEMPOTENCY_NS, idemKey))) {
      res.status(409).json({ ok: false, error: "This receiving is already saving. Wait a moment." })
      return
    }
  }
  let reply: { status: number; body: any } = { status: 500, body: { ok: false, error: "Not saved" } }
  try {
    reply = await save(req)
  } catch (e: any) {
    reply = { status: 500, body: { ok: false, error: e?.message ?? String(e) } }
  } finally {
    if (idemKey) {
      await setIdempotentResponse(IDEMPOTENCY_NS, idemKey, reply.status, reply.body)
      await releaseInflightLock(IDEMPOTENCY_NS, idemKey)
    }
  }
  res.status(reply.status).json(reply.body)
}

async function save(req: MedusaRequest): Promise<{ status: number; body: any }> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const body = (req.body ?? {}) as Body
  const bad = (error: string) => ({ status: 400, body: { ok: false, error } })

  const restocks = (body.restocks ?? []).map((r) => ({
    inventoryItemId: String(r.inventoryItemId ?? ""),
    qty: num(r.qty),
    cost: num(r.cost),
    boxPrice: num(r.boxPrice) > 0 ? num(r.boxPrice) : null,
    casePrice: num(r.casePrice) > 0 ? num(r.casePrice) : null,
  }))
  const products: NewProductIn[] = (body.products ?? []).map((p) => ({
    title: String(p.title ?? ""),
    brand: p.brand ? String(p.brand) : null,
    categoryId: String(p.categoryId ?? ""),
    description: p.description ? String(p.description) : null,
    unitCount: num(p.unitCount),
    unitName: String(p.unitName ?? ""),
    perCase: num(p.perCase) > 0 ? num(p.perCase) : null,
    options: (p.options ?? []).map((o) => ({ title: String(o.title ?? ""), values: (o.values ?? []).map(String) })),
    items: (p.items ?? []).map((it) => ({
      values: Object.fromEntries(Object.entries(it.values ?? {}).map(([k, v]) => [String(k).trim(), String(v)])),
      upc: it.upc ? String(it.upc) : null,
      qty: num(it.qty),
      cost: num(it.cost),
      boxPrice: num(it.boxPrice),
      casePrice: num(it.casePrice) > 0 ? num(it.casePrice) : null,
      imageUrls: (it.imageUrls ?? []).map(String),
    })),
    imageUrls: (p.imageUrls ?? []).map(String),
  }))

  if (restocks.length + products.length === 0) return bad("Add at least one line.")
  if (!body.invoiceNumber || !body.invoiceDate) return bad("Invoice number and date are required.")
  if (!String(body.supplier?.name ?? "").trim()) return bad("Pick the supplier.")
  if (restocks.some((r) => !r.inventoryItemId || !(r.qty > 0))) return bad("Every line needs the boxes received.")

  const allCosts = [...restocks.map((r) => r.cost), ...products.flatMap((p) => p.items.map((i) => i.cost))]
  if (body.freeStock !== true && allCosts.some((c) => !(c > 0))) {
    return bad("A line has no cost. Enter it, or tick “This is free stock”.")
  }

  const profile = await findProfile(req.scope, String(body.profileKey ?? ""))
  if (!profile) return bad(`Unknown category "${body.profileKey}".`)
  if (profile.archived) return bad(`${profile.displayName} is archived in MBS Settings → Categories.`)
  if (!profile.fields.brand) return bad(`${profile.displayName} isn't set up as brands we resell.`)

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const shippingRates = (await settings.getSetting("shipping_rates")) as ShippingRates | null
  const goods = restocks.reduce((s, r) => s + r.qty * r.cost, 0)
    + products.reduce((s, p) => s + p.items.reduce((t, i) => t + i.qty * i.cost, 0), 0)
  const ctx = await buildStockContext(req.scope, profile, Math.max(0, num(body.freight)), goods, shippingRates)

  /* What this invoice + supplier already saved. */
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)
  let existingRecord: any = null
  try {
    const sameNumber = await history.listReceivingRecords({ invoice_number: [body.invoiceNumber] }, { take: 50, order: { created_at: "DESC" } })
    existingRecord = (sameNumber as any[]).find((r) => normName(r.supplier?.name) === normName(body.supplier?.name)) ?? null
  } catch (e: any) {
    return { status: 500, body: { ok: false, error: `Couldn't check what invoice ${body.invoiceNumber} already saved, so nothing was saved: ${e?.message ?? e}` } }
  }
  const savedKeys = new Set(
    ((existingRecord?.line_results ?? []) as any[])
      .filter((l) => l.action === "created" || l.action === "restocked")
      .map((l) => lineKey(l.strainName, l.tier)),
  )

  /* ---- Check everything before writing ---- */
  const errors: string[] = []
  const items = await loadItems(req.scope, restocks.map((r) => r.inventoryItemId))
  for (const r of restocks) {
    const item = items.get(r.inventoryItemId)
    if (!item) errors.push(`A restock line points at stock that no longer exists. Reload the page.`)
    else if (!item.categoryId || !ctx.categories.has(item.categoryId)) errors.push(`"${item.productTitle}" isn't in ${profile.displayName}.`)
    else if (!item.box) errors.push(`"${item.productTitle}" has no box to restock.`)
  }
  for (const id of duplicateRestocks(restocks)) {
    const item = items.get(id)
    errors.push(`${item ? itemName(item.productTitle, item.values) : "A product"} is listed twice. Combine the lines.`)
  }
  for (const p of products) {
    const e = checkNewProduct(p, ctx)
    if (e) errors.push(e)
  }
  /* A UPC already in the catalog is a restock, not a new product. */
  const newUpcs = products.flatMap((p) => p.items.map((i) => String(i.upc ?? "").trim()).filter(Boolean))
  if (newUpcs.length) {
    if (new Set(newUpcs).size !== newUpcs.length) errors.push("Two new lines have the same UPC.")
    const productModule: any = req.scope.resolve(Modules.PRODUCT)
    const taken = await productModule.listProductVariants({ barcode: newUpcs }, { take: 50, relations: ["product"] })
    for (const v of taken as any[]) {
      errors.push(`UPC ${v.barcode} is already "${v.product?.title ?? "a product"}". Restock that one instead of adding a new product.`)
    }
  }
  if (errors.length) {
    return { status: 200, body: { ok: false, nothingSaved: true, errors, error: errors[0] } }
  }

  /* ---- Save ---- */
  const results: StockLineResult[] = []
  const skipped: string[] = []
  await inPool(restocks, async (r) => {
    const item = items.get(r.inventoryItemId)!
    const category = ctx.categories.get(item.categoryId!)
    const name = itemName(item.productTitle, item.values)
    if (savedKeys.has(lineKey(name, category?.handle))) {
      skipped.push(name)
      return
    }
    results.push(await restockItem(req.scope, r, item, ctx))
  })
  const takenSkus = new Set<string>()
  for (const p of products) {
    const category = ctx.categories.get(p.categoryId)
    const names = p.items.map((i) => itemName(p.title, i.values))
    if (names.every((n) => savedKeys.has(lineKey(n, category?.handle)))) {
      skipped.push(...names)
      continue
    }
    results.push(...await createProduct(req.scope, p, ctx, takenSkus))
  }

  const summary = {
    created: results.filter((r) => r.action === "created").length,
    restocked: results.filter((r) => r.action === "restocked").length,
    failed: results.filter((r) => r.action === "failed").length,
    alreadySaved: skipped.length,
  }
  for (const r of results) {
    if (r.action === "failed") logger.warn(`[receiving:stock] ${r.strainName}: ${r.error}`)
    else if (r.warning) logger.warn(`[receiving:stock] ${r.strainName}: ${r.warning}`)
  }

  /* One record per invoice + supplier; this save's lines win. */
  let historyId: string | undefined = existingRecord?.id
  let historyError: string | undefined
  if (results.length) {
    try {
      const byLine = new Map<string, any>()
      /* Already on a QuickBooks Bill: mark the earlier lines as on it,
       * so this save's lines show as not in QuickBooks yet. */
      const earlier = (existingRecord?.line_results ?? []) as any[]
      const billId = existingRecord?.qbo_bill_id ? String(existingRecord.qbo_bill_id) : null
      const stampEarlier = !!billId && !earlier.some((r) => r.qboBillId)
      for (const r of earlier) {
        const kept = stampEarlier && (r.action === "created" || r.action === "restocked") ? { ...r, qboBillId: billId } : r
        byLine.set(lineKey(r.strainName, r.tier), kept)
      }
      for (const r of results) byLine.set(lineKey(r.strainName, r.tier), r)
      const lineResults = Array.from(byLine.values())
      const record = {
        invoice_number: body.invoiceNumber,
        invoice_date: body.invoiceDate,
        supplier: body.supplier ?? {},
        shipping_total: num(body.freight).toFixed(2),
        invoice_total: num(body.total).toFixed(2),
        total_qps: lineResults.reduce((s, r: any) => s + (r.qtyQps || 0), 0),
        line_results: lineResults,
        notes: null,
      }
      if (existingRecord) {
        await history.updateReceivingRecords([{ id: existingRecord.id, ...record }])
      } else {
        const [created] = await history.createReceivingRecords([record])
        historyId = created.id
      }
    } catch (e: any) {
      historyError = e?.message ?? String(e)
      logger.error(`[receiving:stock] history write failed: ${historyError}`)
    }
  }

  if (summary.created + summary.restocked > 0 && historyId) {
    try {
      await req.scope.resolve(Modules.EVENT_BUS).emit({
        name: "receiving.saved",
        data: { history_id: historyId, profile_key: profile.key, summary },
      })
    } catch (e: any) {
      logger.warn(`[receiving:stock] event emit failed: ${e?.message}`)
    }
  }

  if (body.draftId && summary.failed === 0) {
    await (req.scope.resolve(RECEIVING_DRAFTS_MODULE) as any).deleteReceivingDrafts([body.draftId]).catch(() => {})
  }

  return {
    status: 200,
    body: {
      ok: summary.failed === 0,
      summary,
      results,
      skipped,
      historyId,
      qboBillId: existingRecord?.qbo_bill_id ?? null,
      historyError,
      error: summary.failed > 0 ? results.find((r) => r.action === "failed")?.error : undefined,
    },
  }
}

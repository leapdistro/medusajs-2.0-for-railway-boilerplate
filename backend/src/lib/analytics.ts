/**
 * Admin → Analytics: sales, cost, cash and customers for a date range.
 *
 * Revenue — orders placed in the range (order date), cancelled orders
 *   left out. Goods are counted the way the QBO invoice bills them
 *   (lib/billable-quantities: shipped minus returned once anything has
 *   shipped, else ordered), at the current (edited) price.
 * COGS — per line: billed qty × pool units per line (the variant's
 *   required_quantity: 1 × LB = 4 QP) × cost per pool unit. The cost is
 *   the landed cost of the last receiving of that inventory item saved
 *   before the order, else the item's current landed_per_qp. Lines with
 *   neither are listed as missing cost, and their revenue is left out
 *   of the margin so it isn't inflated.
 * Payments — QuickBooks Payments by payment date (TxnDate), which
 *   covers card payments, Net-terms payments and partial payments.
 *   Refunds come from Medusa.
 * Open balance — a snapshot as of now, not limited to the range.
 */

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { billableLines } from "./billable-quantities"
import { loadCategoryTree } from "./category-tree"
import { queryAll } from "./qbo-api"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"

export type Bucket = "day" | "week" | "month"

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number => {
  if (v == null) return 0
  if (typeof v === "object" && "value" in (v as any)) return num((v as any).value)
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** YYYY-MM-DD of `d` in time zone `tz`. */
function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
}

function bucketKey(date: string, bucket: Bucket): string {
  if (bucket === "day") return date
  if (bucket === "month") return date.slice(0, 7)
  /* Week starting Monday. */
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

function bucketsBetween(fromDate: string, toDate: string, bucket: Bucket): string[] {
  const out: string[] = []
  const d = new Date(`${fromDate}T12:00:00Z`)
  const end = new Date(`${toDate}T12:00:00Z`)
  while (d <= end && out.length < 1000) {
    const k = bucketKey(d.toISOString().slice(0, 10), bucket)
    if (out[out.length - 1] !== k) out.push(k)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export function pickBucket(fromDate: string, toDate: string): Bucket {
  const days = (Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000
  return days <= 45 ? "day" : days <= 200 ? "week" : "month"
}

type Money = { revenue: number; goods: number; shipping: number; cogs: number; costedGoods: number }
const emptyMoney = (): Money => ({ revenue: 0, goods: 0, shipping: 0, cogs: 0, costedGoods: 0 })
const marginOf = (m: Money) => ({
  gross_profit: round2(m.costedGoods - m.cogs),
  margin_pct: m.costedGoods > 0 ? round2(((m.costedGoods - m.cogs) / m.costedGoods) * 100) : null,
})

export async function analyticsReport(scope: any, args: { from: string; to: string; tz: string; bucket?: Bucket }) {
  const { from, to, tz } = args
  const fromTs = new Date(from)
  const toTs = new Date(to)
  if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime()) || toTs <= fromTs) {
    throw new Error("from and to must be timestamps with to after from")
  }
  const fromDate = localDate(fromTs, tz)
  const toDate = localDate(new Date(toTs.getTime() - 1), tz)
  const bucket = args.bucket ?? pickBucket(fromDate, toDate)

  const query: any = scope.resolve(ContainerRegistrationKeys.QUERY)
  const pg: any = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  /* ---- Orders placed in the range ---- */
  const orders: any[] = []
  for (let skip = 0; ; skip += 200) {
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "created_at", "status", "canceled_at", "customer_id", "email",
        "total", "shipping_total", "discount_total", "metadata",
        "items.id", "items.quantity", "items.raw_quantity", "items.unit_price",
        "items.variant_id", "items.product_id", "items.product_title", "items.variant_title", "items.variant_sku",
        "items.detail.quantity", "items.detail.unit_price",
        "items.detail.fulfilled_quantity", "items.detail.return_received_quantity",
      ],
      filters: { created_at: { $gte: fromTs.toISOString(), $lt: toTs.toISOString() } },
      pagination: { skip, take: 200, order: { created_at: "ASC" } },
    })
    orders.push(...(data ?? []))
    if ((data ?? []).length < 200) break
  }
  const live = orders.filter((o) => o.status !== "canceled" && !o.canceled_at)
  const canceled = orders.length - live.length

  /* ---- Cost basis ---- */
  const variantIds = [...new Set(live.flatMap((o) => (o.items ?? []).map((i: any) => i.variant_id)).filter(Boolean))]
  const productIds = [...new Set(live.flatMap((o) => (o.items ?? []).map((i: any) => i.product_id)).filter(Boolean))]

  /* Link rows include soft-deleted variants (retired products still have
   * old order lines). Latest link per variant wins. */
  const links = new Map<string, { inventoryItemId: string; poolUnits: number }>()
  if (variantIds.length) {
    const { rows } = await pg.raw(
      `select variant_id, inventory_item_id, required_quantity
         from product_variant_inventory_item
        where variant_id = any(?)
        order by deleted_at nulls last, created_at desc`,
      [variantIds],
    )
    for (const r of rows) {
      if (!links.has(r.variant_id)) links.set(r.variant_id, { inventoryItemId: r.inventory_item_id, poolUnits: Number(r.required_quantity) || 1 })
    }
  }
  const invIds = [...new Set([...links.values()].map((l) => l.inventoryItemId))]
  const currentCost = new Map<string, number>()
  if (invIds.length) {
    const { rows } = await pg.raw(`select id, metadata->>'landed_per_qp' as landed from inventory_item where id = any(?)`, [invIds])
    for (const r of rows) {
      const n = Number(r.landed)
      if (Number.isFinite(n) && n > 0) currentCost.set(r.id, n)
    }
  }
  /* Every receiving's cost per inventory item, oldest first. */
  const receivedCosts = new Map<string, Array<{ at: number; cost: number }>>()
  if (invIds.length) {
    const { rows } = await pg.raw(
      `select r.created_at, l->>'inventoryItemId' as inv, l->>'landedPerQp' as cost
         from receiving_record r, jsonb_array_elements(r.line_results::jsonb) l
        where r.deleted_at is null
          and l->>'inventoryItemId' = any(?)
          and coalesce(l->>'error', '') = ''
        order by r.created_at`,
      [invIds],
    )
    for (const r of rows) {
      const cost = Number(r.cost)
      if (!(cost > 0)) continue
      const list = receivedCosts.get(r.inv) ?? []
      list.push({ at: new Date(r.created_at).getTime(), cost })
      receivedCosts.set(r.inv, list)
    }
  }
  const costAt = (invId: string, at: number): number | null => {
    const list = receivedCosts.get(invId) ?? []
    let found: number | null = null
    for (const e of list) { if (e.at <= at) found = e.cost; else break }
    return found ?? currentCost.get(invId) ?? null
  }

  /* ---- Product lines: top-level › next level ---- */
  const tree = await loadCategoryTree(query)
  const lineOf = new Map<string, string>()
  if (productIds.length) {
    const { rows } = await pg.raw(`select product_id, product_category_id from product_category_product where product_id = any(?)`, [productIds])
    const byProduct = new Map<string, string[]>()
    for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r.product_category_id])
    for (const [pid, cats] of byProduct) {
      let best: { name: string }[] = []
      for (const c of cats) { const p = tree.pathOf(c); if (p.length > best.length) best = p }
      lineOf.set(pid, best.slice(0, 2).map((c) => c.name).join(" › ") || "Uncategorised")
    }
  }

  /* ---- Customers ---- */
  const customerIds = [...new Set(live.map((o) => o.customer_id).filter(Boolean))]
  const names = new Map<string, string>()
  const firstOrderAt = new Map<string, number>()
  if (customerIds.length) {
    const { rows } = await pg.raw(
      `select id, email, company_name, metadata->>'business_name' as business from customer where id = any(?)`,
      [customerIds],
    )
    for (const r of rows) names.set(r.id, r.company_name || r.business || r.email)
    const first = await pg.raw(
      `select customer_id, min(created_at) as first_at from "order"
        where deleted_at is null and canceled_at is null and status <> 'canceled' and customer_id = any(?)
        group by customer_id`,
      [customerIds],
    )
    for (const r of first.rows) firstOrderAt.set(r.customer_id, new Date(r.first_at).getTime())
  }

  /* ---- Roll up ---- */
  const total = emptyMoney()
  const series = new Map<string, Money & { orders: number }>(bucketsBetween(fromDate, toDate, bucket).map((k) => [k, { ...emptyMoney(), orders: 0 }]))
  const byLine = new Map<string, Money & { units: number }>()
  const byCustomer = new Map<string, Money & { orders: number; name: string; first_order: boolean }>()
  const byProduct = new Map<string, Money & { units: number; name: string; line: string }>()
  const missingCost = new Map<string, { product: string; sku: string | null; orders: Set<number>; revenue: number }>()
  const orderRows: any[] = []

  for (const o of live) {
    const at = new Date(o.created_at).getTime()
    const { lines } = billableLines(o.items, { canceled: false })
    const lineById = new Map(lines.map((l) => [l.id, l]))
    const om = emptyMoney()
    let uncosted = false
    om.shipping = num(o.shipping_total)
    for (const it of o.items ?? []) {
      const l = lineById.get(String(it.id))
      if (!l || l.billed <= 0) continue
      const goods = l.unitPrice * l.billed
      const link = it.variant_id ? links.get(it.variant_id) : undefined
      const unitCost = link ? costAt(link.inventoryItemId, at) : null
      const cogs = unitCost != null ? unitCost * link!.poolUnits * l.billed : 0
      om.goods += goods
      if (unitCost != null) { om.cogs += cogs; om.costedGoods += goods }
      else {
        uncosted = true
        const key = it.variant_id ?? it.product_title ?? "?"
        const m = missingCost.get(key) ?? { product: [it.product_title, it.variant_title].filter(Boolean).join(" · "), sku: it.variant_sku ?? null, orders: new Set<number>(), revenue: 0 }
        m.orders.add(o.display_id); m.revenue += goods
        missingCost.set(key, m)
      }
      const lineName = (it.product_id && lineOf.get(it.product_id)) || "Uncategorised"
      const bl = byLine.get(lineName) ?? { ...emptyMoney(), units: 0 }
      bl.goods += goods; bl.revenue += goods; bl.units += l.billed
      if (unitCost != null) { bl.cogs += cogs; bl.costedGoods += goods }
      byLine.set(lineName, bl)
      const pk = it.product_id ?? it.product_title ?? "?"
      const bp = byProduct.get(pk) ?? { ...emptyMoney(), units: 0, name: it.product_title ?? "?", line: lineName }
      bp.goods += goods; bp.revenue += goods; bp.units += l.billed
      if (unitCost != null) { bp.cogs += cogs; bp.costedGoods += goods }
      byProduct.set(pk, bp)
    }
    /* Discounts come off goods. */
    om.goods -= num(o.discount_total)
    om.revenue = om.goods + om.shipping

    for (const k of Object.keys(om) as (keyof Money)[]) total[k] += om[k]
    const s = series.get(bucketKey(localDate(new Date(o.created_at), tz), bucket))
    if (s) { for (const k of Object.keys(om) as (keyof Money)[]) s[k] += om[k]; s.orders += 1 }

    const cid = o.customer_id ?? o.email ?? "guest"
    const bc = byCustomer.get(cid) ?? { ...emptyMoney(), orders: 0, name: names.get(o.customer_id) ?? o.email ?? "Guest", first_order: false }
    for (const k of Object.keys(om) as (keyof Money)[]) bc[k] += om[k]
    bc.orders += 1
    const first = o.customer_id ? firstOrderAt.get(o.customer_id) : undefined
    if (first != null && first >= fromTs.getTime() && first < toTs.getTime()) bc.first_order = true
    byCustomer.set(cid, bc)

    orderRows.push({
      display_id: o.display_id, id: o.id, date: localDate(new Date(o.created_at), tz),
      customer: bc.name, goods: round2(om.goods), shipping: round2(om.shipping), revenue: round2(om.revenue),
      cogs: round2(om.cogs), ...marginOf(om), cost_complete: !uncosted,
      payment_status: o.metadata?.qbo_payment_status ?? null,
    })
  }

  const money = (m: Money) => ({
    revenue: round2(m.revenue), goods: round2(m.goods), shipping: round2(m.shipping), cogs: round2(m.cogs),
    costed_goods: round2(m.costedGoods), ...marginOf(m),
  })
  const byRevenue = <T extends { revenue: number }>(a: T, b: T) => b.revenue - a.revenue

  /* ---- Customers in the range ---- */
  const { rows: custRows } = await pg.raw(
    `select
       count(*) filter (where created_at >= ? and created_at < ?) as signed_up,
       count(*) filter (where (metadata->>'welcomed_at')::timestamptz >= ? and (metadata->>'welcomed_at')::timestamptz < ?) as approved,
       /* application_status isn't moved on approval; welcomed_at is. */
       count(*) filter (where metadata->>'welcomed_at' is null and coalesce(metadata->>'application_status', '') <> 'denied') as pending_now
     from customer where deleted_at is null`,
    [fromTs, toTs, fromTs, toTs],
  ).catch(() => ({ rows: [{}] }))
  const buyers = [...byCustomer.values()]

  /* ---- Refunds (Medusa) ---- */
  const { rows: refundRows } = await pg.raw(
    `select coalesce(sum(amount), 0) as amount, count(*) as n from refund where deleted_at is null and created_at >= ? and created_at < ?`,
    [fromTs, toTs],
  )

  return {
    range: { from: fromTs.toISOString(), to: toTs.toISOString(), from_date: fromDate, to_date: toDate, tz, bucket },
    sales: {
      ...money(total),
      orders: live.length,
      canceled_orders: canceled,
      average_order: live.length ? round2(total.revenue / live.length) : 0,
    },
    series: [...series.entries()].map(([key, m]) => ({ key, orders: m.orders, ...money(m) })),
    product_lines: [...byLine.entries()].map(([name, m]) => ({ name, units: m.units, ...money(m) })).sort(byRevenue),
    top_products: [...byProduct.values()].map((m) => ({ name: m.name, line: m.line, units: m.units, ...money(m) })).sort(byRevenue).slice(0, 15),
    top_customers: buyers.map((m) => ({ name: m.name, orders: m.orders, first_order: m.first_order, ...money(m) })).sort(byRevenue).slice(0, 15),
    customers: {
      signed_up: Number(custRows[0]?.signed_up ?? 0),
      approved: Number(custRows[0]?.approved ?? 0),
      pending_applications: Number(custRows[0]?.pending_now ?? 0),
      buying: buyers.length,
      first_time_buyers: buyers.filter((b) => b.first_order).length,
      repeat_buyers: buyers.filter((b) => !b.first_order).length,
    },
    missing_cost: [...missingCost.values()]
      .map((m) => ({ product: m.product, sku: m.sku, orders: [...m.orders].sort((a, b) => a - b), revenue: round2(m.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    refunds: { amount: round2(num(refundRows[0]?.amount)), count: Number(refundRows[0]?.n ?? 0) },
    payments: await qboPayments(scope, pg, fromDate, toDate),
    open_balance: await openBalance(pg),
    orders: orderRows,
  }
}

/** QuickBooks Payments dated in the range. Payments applied to a portal
 *  invoice are split from the rest (payments on invoices made outside
 *  the portal). */
async function qboPayments(scope: any, pg: any, fromDate: string, toDate: string) {
  try {
    const qbo: any = scope.resolve(QBO_CONNECTION_MODULE)
    const [conn] = await qbo.listQboConnections({}, { take: 1 })
    if (!conn) return { error: "QuickBooks isn't connected" }
    const rows = await queryAll(qbo, conn, "Payment", `where TxnDate >= '${fromDate}' and TxnDate <= '${toDate}'`)
    const { rows: inv } = await pg.raw(
      `select metadata->>'qbo_invoice_id' as inv from "order" where deleted_at is null and metadata->>'qbo_invoice_id' is not null`,
    )
    const portalInvoices = new Set(inv.map((r: any) => String(r.inv)))
    let total = 0
    let portal = 0
    const daily = new Map<string, number>()
    for (const p of rows) {
      const amt = num(p.TotalAmt)
      total += amt
      for (const line of p.Line ?? []) {
        const linked = (line.LinkedTxn ?? []).some((t: any) => t.TxnType === "Invoice" && portalInvoices.has(String(t.TxnId)))
        if (linked) portal += num(line.Amount)
      }
      daily.set(p.TxnDate, (daily.get(p.TxnDate) ?? 0) + amt)
    }
    return {
      total: round2(total),
      count: rows.length,
      on_portal_orders: round2(portal),
      other: round2(total - portal),
      by_date: [...daily.entries()].sort().map(([date, amount]) => ({ date, amount: round2(amount) })),
    }
  } catch (e: any) {
    return { error: `Couldn't read QuickBooks payments: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** Unpaid balance on every live order, aged by order date. */
async function openBalance(pg: any) {
  const { rows } = await pg.raw(
    `select o.id, o.display_id, o.created_at, o.customer_id,
            coalesce(c.company_name, c.metadata->>'business_name', c.email, o.email) as customer,
            o.metadata->>'qbo_payment_status' as status,
            o.metadata->>'qbo_balance' as qbo_balance,
            (s.totals->>'current_order_total')::numeric - coalesce((s.totals->>'paid_total')::numeric, 0)
              + coalesce((s.totals->>'refunded_total')::numeric, 0) as medusa_balance
       from "order" o
       join order_summary s on s.order_id = o.id and s.version = o.version and s.deleted_at is null
       left join customer c on c.id = o.customer_id
      where o.deleted_at is null and o.canceled_at is null and o.status <> 'canceled'
        and coalesce(o.metadata->>'qbo_payment_status', '') not in ('paid', 'voided')`,
  )
  const now = Date.now()
  const buckets = [
    { label: "0–15 days", max: 15, amount: 0, count: 0 },
    { label: "16–30 days", max: 30, amount: 0, count: 0 },
    { label: "31–60 days", max: 60, amount: 0, count: 0 },
    { label: "Over 60 days", max: Infinity, amount: 0, count: 0 },
  ]
  const owing = new Map<string, { customer: string; amount: number; orders: number[]; oldest_days: number }>()
  let total = 0
  for (const r of rows) {
    /* QBO's balance once the invoice exists (it knows partial payments). */
    const bal = r.qbo_balance != null ? Number(r.qbo_balance) : Number(r.medusa_balance)
    if (!(bal > 0.004)) continue
    const days = Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000)
    const b = buckets.find((x) => days <= x.max)!
    b.amount += bal; b.count += 1
    total += bal
    const key = r.customer_id ?? r.customer
    const ow = owing.get(key) ?? { customer: r.customer ?? "Guest", amount: 0, orders: [], oldest_days: 0 }
    ow.amount += bal; ow.orders.push(r.display_id); ow.oldest_days = Math.max(ow.oldest_days, days)
    owing.set(key, ow)
  }
  return {
    total: round2(total),
    count: buckets.reduce((s, b) => s + b.count, 0),
    aging: buckets.map(({ label, amount, count }) => ({ label, amount: round2(amount), count })),
    customers: [...owing.values()]
      .map((o) => ({ ...o, amount: round2(o.amount), orders: o.orders.sort((a, b) => a - b) }))
      .sort((a, b) => b.amount - a.amount),
  }
}

/**
 * Billable quantity per order line — the ONE place that decides how many
 * units of a line we charge for. Consumed by the QBO invoice push and the
 * capture-on-fulfillment subscriber; the storefront's lib/orders.ts
 * mirrors the same rule for the /account order page + invoice PDF.
 *
 * Source: `items.detail.fulfilled_quantity` — Medusa's OrderItem counter,
 * kept in LINE units (1 × LB = 1) and decremented when a fulfillment is
 * cancelled.
 *
 * Do NOT sum `fulfillments.items.quantity`. Fulfillment items are written
 * per inventory item in POOL units (ordered qty × variant
 * required_quantity), so 1 × LB flower fulfils as 4 and 1 × Half as 2.
 * Summing them billed LB lines 4× on QBO invoices 1206 / 1246 (orders
 * 317 / 332) and inflated order 151.
 *
 * Wholesale rule: bill what shipped. Lines are clamped to the ordered qty
 * so a bad counter can never bill more than was bought. Before any
 * fulfillment exists we bill the ordered qty (manual push / pre-ship PDF).
 *
 * Query fields required on the order:
 *   "items.id", "items.quantity", "items.raw_quantity",
 *   "items.detail.quantity", "items.detail.fulfilled_quantity",
 *   "items.unit_price"
 */

type BillableItem = {
  id?: string | null
  quantity?: unknown
  raw_quantity?: unknown
  unit_price?: unknown
  detail?: { quantity?: unknown; fulfilled_quantity?: unknown } | null
}

function num(v: unknown): number {
  if (v == null) return 0
  if (typeof v === "object" && v !== null && "value" in (v as any)) return num((v as any).value)
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Ordered qty in line units. `quantity` can read 0 after a fulfillment
 *  cancellation; detail.quantity / raw_quantity keep the original. */
export function orderedQty(item: BillableItem): number {
  const q = num(item.quantity)
  if (q > 0) return q
  return num(item.detail?.quantity) || num(item.raw_quantity)
}

export function fulfilledQty(item: BillableItem): number {
  return Math.max(0, num(item.detail?.fulfilled_quantity))
}

export type BillableLine = { id: string; ordered: number; billed: number; unitPrice: number }

export function billableLines(items: BillableItem[] | null | undefined): {
  lines: BillableLine[]
  orderHasFulfillments: boolean
} {
  const list = (items ?? []).filter((it) => it?.id)
  const orderHasFulfillments = list.some((it) => fulfilledQty(it) > 0)
  const lines = list.map((it) => {
    const ordered = orderedQty(it)
    const billed = orderHasFulfillments ? Math.min(fulfilledQty(it), ordered) : ordered
    return { id: String(it.id), ordered, billed, unitPrice: num(it.unit_price) }
  })
  return { lines, orderHasFulfillments }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Σ unit_price × billed — what the buyer owes for goods (excl. shipping). */
export function billableItemsTotal(lines: BillableLine[]): number {
  return round2(lines.reduce((s, l) => s + l.unitPrice * l.billed, 0))
}

/** Σ unit_price × ordered — the hard ceiling for any invoice of this order. */
export function orderedItemsTotal(lines: BillableLine[]): number {
  return round2(lines.reduce((s, l) => s + l.unitPrice * l.ordered, 0))
}

/**
 * Billable quantity + price per order line — the ONE place that decides
 * what we charge for. Consumed by the QBO invoice push/sync and the
 * capture-on-fulfillment subscriber; the storefront's lib/orders.ts
 * mirrors the same rule for the /account order page + invoice PDF.
 *
 * Quantity: `items.detail.fulfilled_quantity` minus
 * `items.detail.return_received_quantity` — Medusa's OrderItem counters,
 * kept in LINE units (1 × LB = 1). Fulfilled drops when a fulfillment is
 * cancelled; returned rises when a return is received.
 *
 * Price: `items.detail.unit_price` — the versioned price after an order
 * edit. `items.unit_price` is the checkout snapshot and never changes
 * (order 340 was invoiced $150 over on it). Falls back to it for lines
 * never edited.
 *
 * Do NOT sum `fulfillments.items.quantity`. Fulfillment items are written
 * per inventory item in POOL units (ordered qty × variant
 * required_quantity), so 1 × LB flower fulfils as 4 and 1 × Half as 2.
 * Summing them billed LB lines 4× on QBO invoices 1206 / 1246 (orders
 * 317 / 332) and inflated order 151.
 *
 * Wholesale rule: bill what shipped and wasn't sent back. Lines are
 * clamped to [0, ordered] so a bad counter can never bill more than was
 * bought. Before any fulfillment exists we bill the ordered qty (manual
 * push / pre-ship PDF) — unless the order is cancelled, which bills 0.
 *
 * Query fields required on the order:
 *   "status", "items.id", "items.quantity", "items.raw_quantity",
 *   "items.unit_price", "items.detail.quantity",
 *   "items.detail.unit_price", "items.detail.fulfilled_quantity",
 *   "items.detail.return_received_quantity"
 */

type BillableItem = {
  id?: string | null
  quantity?: unknown
  raw_quantity?: unknown
  unit_price?: unknown
  detail?: {
    quantity?: unknown
    unit_price?: unknown
    fulfilled_quantity?: unknown
    return_received_quantity?: unknown
  } | null
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

export function returnedQty(item: BillableItem): number {
  return Math.max(0, num(item.detail?.return_received_quantity))
}

/** Current price after any order edit. */
export function unitPriceOf(item: BillableItem): number {
  const edited = item.detail?.unit_price
  return edited != null && edited !== "" ? num(edited) : num(item.unit_price)
}

export type BillableLine = { id: string; ordered: number; billed: number; unitPrice: number }

export function billableLines(
  items: BillableItem[] | null | undefined,
  opts: { canceled?: boolean } = {},
): {
  lines: BillableLine[]
  orderHasFulfillments: boolean
} {
  const list = (items ?? []).filter((it) => it?.id)
  const orderHasFulfillments = list.some((it) => fulfilledQty(it) > 0)
  const lines = list.map((it) => {
    const ordered = orderedQty(it)
    const billed = opts.canceled
      ? 0
      : orderHasFulfillments
        ? Math.min(Math.max(0, fulfilledQty(it) - returnedQty(it)), ordered)
        : ordered
    return { id: String(it.id), ordered, billed, unitPrice: unitPriceOf(it) }
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

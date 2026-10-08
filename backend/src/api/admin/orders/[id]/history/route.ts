import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ORDER_HISTORY_MODULE } from "../../../../../modules/order-history"

/**
 * GET /admin/orders/:id/history
 *
 * The order's History timeline, newest first. Two sources:
 *   - Medusa's own records, read live: order placed, order edits (line
 *     price / quantity before → after, by whom), fulfillments, shipping,
 *     returns, claims, exchanges, payments, refunds, cancellation. Every
 *     order — including ones placed before History existed — gets its
 *     full timeline from these.
 *   - order_history_event: what Medusa doesn't record — QBO invoice
 *     created / updated / voided, sync failures, changes refused because
 *     the invoice is settled (lib/order-history-log.ts).
 */

type Actor = { type: "admin" | "customer" | "system" | "qbo"; label: string }
type Change = { label: string; before?: string | null; after?: string | null }
type HistoryEntry = { id: string; at: string; actor: Actor; action: string; summary: string; changes?: Change[] }

const money = (n: unknown) => {
  const v = Number((n as any)?.value ?? n)
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—"
}
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null)

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const pg: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "created_at", "canceled_at", "status", "email", "metadata",
      "customer.first_name", "customer.last_name", "customer.email",
      "items.id", "items.title", "items.product_title", "items.variant_title", "items.unit_price",
      "fulfillments.id", "fulfillments.created_at", "fulfillments.shipped_at", "fulfillments.delivered_at",
      "fulfillments.canceled_at", "fulfillments.created_by", "fulfillments.marked_shipped_by",
      "fulfillments.labels.tracking_number",
      "payment_collections.payments.id", "payment_collections.payments.amount",
      "payment_collections.payments.provider_id", "payment_collections.payments.created_at",
      "payment_collections.payments.captured_at", "payment_collections.payments.canceled_at",
      "payment_collections.payments.refunds.id", "payment_collections.payments.refunds.amount",
      "payment_collections.payments.refunds.created_at", "payment_collections.payments.refunds.created_by",
      "payment_collections.payments.refunds.note",
    ],
    filters: { id: orderId },
  })
  const order = (data as any[])[0]
  if (!order) return res.status(404).json({ message: `Order ${orderId} not found` })

  const [changes, returns, claims, exchanges, logged, originals] = await Promise.all([
    orderService.listOrderChanges({ order_id: orderId }, { relations: ["actions"], take: 500 }).catch(() => []),
    orderService.listReturns({ order_id: orderId }, { relations: ["items"], take: 100 }).catch(() => []),
    orderService.listOrderClaims({ order_id: orderId }, { take: 100 }).catch(() => []),
    orderService.listOrderExchanges({ order_id: orderId }, { take: 100 }).catch(() => []),
    (req.scope.resolve(ORDER_HISTORY_MODULE) as any)
      .listOrderHistoryEvents({ order_id: orderId }, { take: 1000 }).catch(() => []),
    /* Quantity each line was ORDERED at (order_item version 1) — the
     * starting point for "quantity a → b" on order edits. */
    pg.raw(`select item_id, quantity from order_item where order_id = ? and version = 1 and deleted_at is null`, [orderId])
      .then((r: any) => r.rows ?? []).catch(() => []),
  ])

  /* ── Who did it ── */
  const userIds = new Set<string>()
  for (const c of changes as any[]) for (const k of ["created_by", "confirmed_by", "requested_by", "canceled_by"]) if (c?.[k]) userIds.add(c[k])
  for (const f of order.fulfillments ?? []) for (const k of ["created_by", "marked_shipped_by"]) if (f?.[k]) userIds.add(f[k])
  for (const r of returns as any[]) if (r?.created_by) userIds.add(r.created_by)
  for (const e of logged as any[]) if (e?.actor_type === "admin" && e?.actor_id) userIds.add(e.actor_id)
  for (const p of order.payment_collections?.flatMap((pc: any) => pc?.payments ?? []) ?? []) {
    for (const rf of p?.refunds ?? []) if (rf?.created_by) userIds.add(rf.created_by)
  }
  const users = new Map<string, string>()
  if (userIds.size) {
    const userService: any = req.scope.resolve(Modules.USER)
    const list = await userService.listUsers({ id: [...userIds] }, { take: userIds.size }).catch(() => [])
    for (const u of list as any[]) {
      users.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "Admin")
    }
  }
  const admin = (id?: string | null): Actor =>
    id ? { type: "admin", label: users.get(id) ?? "Admin" } : { type: "system", label: "System" }
  const customerLabel = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ")
    || order.customer?.email || order.email || "Customer"

  const itemTitle = new Map<string, string>()
  for (const it of order.items ?? []) {
    const name = it.product_title ?? it.title ?? "Item"
    itemTitle.set(it.id, it.variant_title ? `${name} · ${it.variant_title}` : name)
  }
  const label = (lineId?: string | null) => (lineId && itemTitle.get(lineId)) || "Item"

  const out: HistoryEntry[] = []
  const push = (e: Omit<HistoryEntry, "at"> & { at: unknown }) => {
    const at = iso(e.at)
    if (at) out.push({ ...e, at })
  }

  push({ id: `placed`, at: order.created_at, actor: { type: "customer", label: customerLabel }, action: "order.placed", summary: "Order placed" })

  /* ── Order edits: replay each line's price + quantity forward so every
   *    edit shows before → after. Starts from the checkout price and the
   *    ordered quantity. ── */
  const price = new Map<string, number>()
  const qty = new Map<string, number>()
  for (const it of order.items ?? []) price.set(it.id, Number(it.unit_price?.value ?? it.unit_price ?? 0))
  for (const row of originals as any[]) qty.set(row.item_id, Number(row.quantity?.value ?? row.quantity ?? 0))

  const sortedChanges = [...(changes as any[])].sort(
    (a, b) => new Date(a.confirmed_at ?? a.created_at).getTime() - new Date(b.confirmed_at ?? b.created_at).getTime(),
  )
  for (const c of sortedChanges) {
    if (c.change_type !== "edit" || c.status !== "confirmed") continue
    const lines: Change[] = []
    for (const a of (c.actions ?? []) as any[]) {
      const ref = a.details?.reference_id ?? a.reference_id
      if (a.action === "ITEM_UPDATE") {
        const newPrice = a.details?.unit_price != null ? Number(a.details.unit_price) : undefined
        const newQty = a.details?.quantity != null ? Number(a.details.quantity) : undefined
        if (newPrice != null && price.get(ref) !== newPrice) {
          lines.push({ label: `${label(ref)} price`, before: money(price.get(ref)), after: money(newPrice) })
          price.set(ref, newPrice)
        }
        if (newQty != null && qty.has(ref) && qty.get(ref) !== newQty) {
          lines.push({ label: `${label(ref)} quantity`, before: String(qty.get(ref)), after: String(newQty) })
        }
        if (newQty != null) qty.set(ref, newQty)
      } else if (a.action === "ITEM_ADD") {
        lines.push({ label: `Added ${label(ref)}`, after: `${a.details?.quantity ?? 1} × ${money(a.details?.unit_price)}` })
      } else if (a.action === "ITEM_REMOVE") {
        lines.push({ label: `Removed ${label(ref)}`, before: String(a.details?.quantity ?? "") })
      } else if (a.action === "SHIPPING_ADD" || a.action === "SHIPPING_REMOVE") {
        lines.push({ label: a.action === "SHIPPING_ADD" ? "Shipping added" : "Shipping removed", after: money(a.amount) })
      }
    }
    push({
      id: `edit_${c.id}`,
      at: c.confirmed_at ?? c.created_at,
      actor: admin(c.confirmed_by ?? c.created_by),
      action: "order.edited",
      summary: lines.length === 1 ? `Order edited: ${lines[0].label}` : `Order edited (${lines.length} changes)`,
      changes: lines,
    })
  }

  /* ── Fulfillment & shipping ── */
  for (const f of order.fulfillments ?? []) {
    push({ id: `ful_${f.id}`, at: f.created_at, actor: admin(f.created_by), action: "fulfillment.created", summary: "Fulfilled" })
    const tracking = (f.labels ?? []).map((l: any) => l?.tracking_number).filter(Boolean).join(", ")
    if (f.shipped_at) push({ id: `ship_${f.id}`, at: f.shipped_at, actor: admin(f.marked_shipped_by), action: "fulfillment.shipped", summary: tracking ? `Shipped · tracking ${tracking}` : "Marked shipped" })
    if (f.delivered_at) push({ id: `dlv_${f.id}`, at: f.delivered_at, actor: { type: "system", label: "System" }, action: "fulfillment.delivered", summary: "Delivered / picked up" })
    if (f.canceled_at) push({ id: `fcan_${f.id}`, at: f.canceled_at, actor: { type: "system", label: "System" }, action: "fulfillment.canceled", summary: "Fulfillment cancelled" })
  }

  /* ── Returns, claims, exchanges ── */
  for (const r of returns as any[]) {
    const items = ((r.items ?? []) as any[]).map((ri) => `${ri.quantity} × ${label(ri.item_id)}`)
    push({ id: `ret_${r.id}`, at: r.requested_at ?? r.created_at, actor: admin(r.created_by), action: "return.requested", summary: `Return requested: ${items.join(", ") || "items"}` })
    if (r.received_at) push({ id: `retr_${r.id}`, at: r.received_at, actor: { type: "system", label: "System" }, action: "return.received", summary: `Return received${r.refund_amount ? ` · refund ${money(r.refund_amount)}` : ""}` })
    if (r.canceled_at) push({ id: `retc_${r.id}`, at: r.canceled_at, actor: { type: "system", label: "System" }, action: "return.canceled", summary: "Return cancelled" })
  }
  for (const c of claims as any[]) push({ id: `clm_${c.id}`, at: c.created_at, actor: admin(c.created_by), action: "claim.created", summary: `Claim #${c.display_id ?? ""} created (${c.type ?? "claim"})` })
  for (const x of exchanges as any[]) push({ id: `exc_${x.id}`, at: x.created_at, actor: admin(x.created_by), action: "exchange.created", summary: `Exchange #${x.display_id ?? ""} created` })

  /* ── Payments ── */
  for (const p of order.payment_collections?.flatMap((pc: any) => pc?.payments ?? []) ?? []) {
    const how = p.provider_id === "pp_system_default" ? "Net terms / manual" : p.provider_id === "pp_kaja-authnet" ? "Card" : (p.provider_id ?? "Payment")
    push({ id: `pay_${p.id}`, at: p.created_at, actor: { type: "system", label: "System" }, action: "payment.authorized", summary: `Payment authorized · ${money(p.amount)} (${how})` })
    if (p.captured_at) push({ id: `cap_${p.id}`, at: p.captured_at, actor: { type: "system", label: "System" }, action: "payment.captured", summary: `Payment captured · ${money(p.amount)}` })
    if (p.canceled_at) push({ id: `pcan_${p.id}`, at: p.canceled_at, actor: { type: "system", label: "System" }, action: "payment.canceled", summary: "Payment cancelled" })
    for (const rf of p.refunds ?? []) {
      push({ id: `ref_${rf.id}`, at: rf.created_at, actor: admin(rf.created_by), action: "payment.refunded", summary: `Refunded ${money(rf.amount)}${rf.note ? ` · ${rf.note}` : ""}` })
    }
  }

  /* ── Cancellation (reason stamped by cancel-with-reason) ── */
  const meta = (order.metadata ?? {}) as Record<string, any>
  const reason = [meta.cancellation_reason_label, meta.cancellation_operator_note].filter(Boolean).join(" — ")
  if (order.canceled_at) {
    push({ id: "canceled", at: order.canceled_at, actor: { type: "system", label: "System" }, action: "order.canceled", summary: `Order cancelled${reason ? ` · ${reason}` : ""}` })
  } else if (meta.cancelled_at_intent) {
    push({ id: "cancel_attempt", at: meta.cancelled_at_intent, actor: { type: "system", label: "System" }, action: "order.cancel_attempted", summary: `Cancellation attempted${reason ? ` (${reason})` : ""} — order was already fulfilled` })
  }

  /* ── Logged events (QBO sync, blocked changes) ── */
  const loggedList = logged as any[]
  for (const e of loggedList) {
    const actor: Actor = e.actor_type === "admin" ? admin(e.actor_id)
      : e.actor_type === "qbo" ? { type: "qbo", label: "QuickBooks" }
      : e.actor_type === "customer" ? { type: "customer", label: customerLabel }
      : { type: "system", label: "System" }
    const d = (e.details ?? {}) as Record<string, any>
    push({
      id: e.id, at: e.occurred_at, actor, action: e.action, summary: e.summary,
      changes: d.before != null || d.after != null ? [{ label: "Invoice total", before: d.before != null ? money(d.before) : null, after: d.after != null ? money(d.after) : null }] : undefined,
    })
  }
  /* Orders pushed before History existed: show the first push from its
   * metadata stamp. */
  if (meta.qbo_pushed_at && !loggedList.some((e) => e.action === "qbo.invoice_created")) {
    push({ id: "qbo_pushed", at: meta.qbo_pushed_at, actor: { type: "system", label: "System" }, action: "qbo.invoice_created", summary: `QuickBooks: invoice ${meta.qbo_doc_number ?? meta.qbo_invoice_id ?? ""} created` })
  }

  out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  res.json({ order_id: orderId, history: out })
}

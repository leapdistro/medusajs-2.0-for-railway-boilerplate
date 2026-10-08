/**
 * Keep an order's QBO Invoice in step with the order in Medusa.
 *
 * One reconcile function instead of a handler per kind of change: build
 * the invoice the order SHOULD have right now (buildInvoiceDraft — edited
 * prices, fulfilled minus returned qty, shipping, cancellation), compare
 * it with what QBO holds, and make the smallest change:
 *
 *   no invoice yet, order fulfilled  → create (pushOrderToQbo)
 *   lines differ, unpaid / part-paid → update the lines in place
 *   nothing left to bill, unpaid     → void (reverses QBO inventory too)
 *   invoice fully paid               → refuse: SETTLED
 *   new total below what was paid    → refuse: BELOW_PAID
 *   nothing differs                  → no-op (safe to run any number of times)
 *
 * Triggered by subscribers/order-qbo-sync.ts on every order change event
 * and by POST /admin/orders/:id/sync-qbo. One sync per order at a time
 * (Redis lock); the outcome is stamped on order.metadata for the QBO
 * widget, which toasts it.
 */
import {
  findOrCreateServiceItem,
  getDefaultAccounts,
  invoicePublicUrl,
  readInvoice,
  updateInvoiceLines,
  voidInvoice,
  type QboInvoice,
} from "./qbo-api"
import { billableLines } from "./billable-quantities"
import {
  buildInvoiceDraft,
  loadQboOrder,
  pushOrderToQbo,
  type InvoiceDraft,
  type Logger,
} from "./qbo-order-push"
import { acquireInflightLock, releaseInflightLock } from "./idempotency"
import { logOrderHistory } from "./order-history-log"

export const SETTLED_MESSAGE =
  "Invoice is settled and cannot be changed. It is fully paid in QuickBooks — record any adjustment there (credit memo or refund)."

export type SyncAction = "created" | "updated" | "voided" | "unchanged" | "skipped"

export type SyncOutcome =
  | { ok: true; action: SyncAction; message: string; invoiceId?: string; total?: number; before?: number; url?: string }
  | { ok: false; code: string; error: string; invoiceId?: string }

const round2 = (n: number) => Math.round(n * 100) / 100
const LOCK_NS = "qbo-order-sync"

/** True when QBO shows the invoice as fully paid. A voided invoice (total
 *  0) is not "settled" — there is nothing paid on it. */
export function isSettled(inv: Pick<QboInvoice, "TotalAmt" | "Balance">): boolean {
  return inv.TotalAmt > 0.004 && inv.Balance <= 0.004
}

function isVoided(inv: QboInvoice): boolean {
  return inv.TotalAmt <= 0.004 && /\bvoided\b/i.test(inv.PrivateNote ?? "")
}

/* Comparison is by DOLLAR AMOUNT per QBO Item, not qty × rate: the same
 * $175 can be "0.25 lb @ $700" or "1 QP @ $175" — e.g. when a product
 * was deleted after the push, the draft can't convert QP → lb. Amount per
 * Item is what the customer is billed and what posts to each Item. */
function invoiceAmounts(inv: QboInvoice): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of inv.Line ?? []) {
    if (l?.DetailType !== "SalesItemLineDetail") continue
    const id = String(l.SalesItemLineDetail?.ItemRef?.value ?? "")
    m.set(id, (m.get(id) ?? 0) + Number(l.Amount ?? 0))
  }
  return m
}

function draftAmounts(draft: InvoiceDraft): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of draft.lines) m.set(l.itemId, (m.get(l.itemId) ?? 0) + round2(l.qty * l.unitPrice))
  if (draft.shippingItemId && draft.shippingTotal > 0) {
    m.set(draft.shippingItemId, (m.get(draft.shippingItemId) ?? 0) + round2(draft.shippingTotal))
  }
  return m
}

/** Same amounts per Item, allowing 2¢ per Item: an edited $266.12/QP
 *  becomes a $1,064.48/lb rate that QBO stores as $266.13 on 0.25 lb. */
function sameAmounts(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (Math.abs((a.get(id) ?? 0) - (b.get(id) ?? 0)) > 0.02) return false
  }
  return true
}

function canonical(m: Map<string, number>): string {
  return [...m.entries()]
    .map(([id, amt]) => [id, round2(amt)] as const)
    .filter(([, amt]) => Math.abs(amt) > 0.004)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, amt]) => `${id}=${amt.toFixed(2)}`)
    .join(" ")
}

/** Merge a patch into the order's CURRENT metadata (re-read, so a
 *  concurrent writer's keys aren't clobbered). */
async function stampOrder(scope: any, orderId: string, patch: Record<string, unknown>): Promise<void> {
  const { Modules } = await import("@medusajs/framework/utils")
  const orderService: any = scope.resolve(Modules.ORDER)
  const [order] = await orderService.listOrders({ id: [orderId] }, { take: 1 })
  if (!order) return
  await orderService.updateOrders(order.id, { metadata: { ...(order.metadata ?? {}), ...patch } })
}

async function withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T | null> {
  /* Event bursts (return requested → received, edit → confirm) can
   * start two syncs at once; wait for the running one rather than race
   * it, then reconcile against the latest order state. */
  for (let i = 0; i < 30; i++) {
    if (await acquireInflightLock(LOCK_NS, orderId)) {
      try { return await fn() } finally { await releaseInflightLock(LOCK_NS, orderId) }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

/** Report what a sync WOULD do, writing nothing (no QBO writes, no order
 *  stamps, missing Items reported instead of created). */
export async function planOrderSync(scope: any, orderId: string, logger: Logger): Promise<SyncOutcome> {
  return reconcile(scope, orderId, logger, true)
}

export async function syncOrderToQbo(
  scope: any,
  orderId: string,
  logger: Logger,
  opts: { logFailures?: boolean } = {},
): Promise<SyncOutcome> {
  const result = await withOrderLock(orderId, () => reconcile(scope, orderId, logger))
  const outcome: SyncOutcome = result ?? {
    ok: false,
    code: "LOCKED",
    error: "Another QuickBooks sync for this order is still running. Try again in a minute.",
  }

  const now = new Date().toISOString()
  try {
    if (outcome.ok === true) {
      if (outcome.action !== "skipped") {
        await stampOrder(scope, orderId, {
          qbo_synced_at: now,
          qbo_sync_action: outcome.action,
          qbo_sync_message: outcome.message,
          qbo_sync_error: null,
          qbo_sync_error_at: null,
          ...(outcome.total != null ? { qbo_invoice_total: outcome.total } : {}),
        })
      }
    } else if (outcome.ok === false) {
      await stampOrder(scope, orderId, {
        qbo_sync_error: outcome.error,
        qbo_sync_error_code: outcome.code,
        qbo_sync_error_at: now,
      })
    }
  } catch (e: any) {
    logger.warn(`[qbo-order-sync] couldn't stamp order ${orderId}: ${e?.message}`)
  }

  /* History: every change that reached (or failed to reach) QBO. */
  if (outcome.ok === true && (outcome.action === "created" || outcome.action === "updated" || outcome.action === "voided")) {
    await logOrderHistory(scope, orderId, {
      action: `qbo.invoice_${outcome.action}`,
      summary: `QuickBooks: ${outcome.message}`,
      details: { invoice_id: outcome.invoiceId ?? null, before: outcome.before ?? null, after: outcome.total ?? null },
    })
  } else if (outcome.ok === false && outcome.code !== "LOCKED" && opts.logFailures !== false) {
    await logOrderHistory(scope, orderId, {
      action: "qbo.sync_failed",
      summary: `QuickBooks sync failed (${outcome.code}): ${outcome.error}`,
      details: { code: outcome.code, invoice_id: outcome.invoiceId ?? null },
    })
  }
  return outcome
}

async function reconcile(scope: any, orderId: string, logger: Logger, dryRun = false): Promise<SyncOutcome> {
  const loaded = await loadQboOrder(scope, orderId)
  if ("ok" in loaded) return { ok: false, code: loaded.code, error: "error" in loaded ? loaded.error : "Load failed" }
  const { qbo, conn, query, order } = loaded
  const label = `#${order.display_id ?? order.id}`
  const invoiceId = order.metadata?.qbo_invoice_id ? String(order.metadata.qbo_invoice_id) : undefined

  /* 1. Never pushed: create once something has shipped (the invoice
   *    bills shipped qty, so there is nothing to bill before that). */
  if (!invoiceId) {
    const canceled = order.status === "canceled"
    if (canceled || !billableLines(order.items, { canceled }).orderHasFulfillments) {
      return { ok: true, action: "skipped", message: `Order ${label} has nothing shipped to invoice yet` }
    }
    if (dryRun) return { ok: true, action: "created", message: `Would create the invoice for order ${label}` }
    const pushed = await pushOrderToQbo(scope, orderId, logger)
    if (pushed.ok === true) {
      return {
        ok: true,
        action: "created",
        invoiceId: pushed.invoiceId,
        url: pushed.url,
        message: `Invoice ${pushed.invoiceId} created`,
      }
    }
    if (pushed.ok === false && pushed.code === "ALREADY_PUSHED") {
      return { ok: true, action: "unchanged", invoiceId: pushed.invoiceId, message: "Already pushed" }
    }
    const failed = pushed as { code: string; error?: string }
    return { ok: false, code: failed.code, error: failed.error ?? "QuickBooks push failed" }
  }

  /* 2. Compare what QBO holds with what the order says now. */
  let inv: QboInvoice
  try {
    inv = await readInvoice(qbo, conn, invoiceId)
  } catch (e: any) {
    return { ok: false, code: "API_ERROR", invoiceId, error: `Couldn't read QBO invoice ${invoiceId}: ${e?.message}` }
  }
  const draft = await buildInvoiceDraft(scope, qbo, conn, query, order, logger, { allowEmpty: true, dryRun })
  if ("ok" in draft) return { ok: false, code: draft.code, invoiceId, error: "error" in draft ? draft.error : "Draft failed" }

  /* Existing invoices keep their Shipping line even when the shipping
   * item couldn't be resolved in the draft; resolve it here so the
   * comparison isn't fooled. */
  if (draft.shippingTotal > 0 && !draft.shippingItemId && !dryRun) {
    try {
      const accounts = await getDefaultAccounts(qbo, conn)
      draft.shippingItemId = (await findOrCreateServiceItem(qbo, conn, "Shipping", accounts.incomeAccount)).id
    } catch { /* compare without it */ }
  }

  const desiredTotal = round2(draft.invoiceLinesTotal + (draft.shippingItemId ? draft.shippingTotal : 0))
  const docLabel = inv.DocNumber ?? invoiceId
  const url = invoicePublicUrl(conn.environment, conn.realm_id, invoiceId)

  const same = sameAmounts(invoiceAmounts(inv), draftAmounts(draft))
  if (dryRun && process.env.QBO_SYNC_DEBUG && !same) {
    console.log(`  ${label} QBO  : ${canonical(invoiceAmounts(inv))}`)
    console.log(`  ${label} WANT : ${canonical(draftAmounts(draft))}`)
  }
  if (same || (isVoided(inv) && desiredTotal <= 0.004)) {
    return { ok: true, action: "unchanged", invoiceId, url, total: inv.TotalAmt, message: `Invoice ${docLabel} already matches` }
  }
  if (isVoided(inv)) {
    return {
      ok: false, code: "VOIDED", invoiceId,
      error: `Invoice ${docLabel} is voided in QuickBooks but the order now bills $${desiredTotal.toFixed(2)}. Push a new invoice from the QuickBooks widget.`,
    }
  }
  if (isSettled(inv)) {
    return { ok: false, code: "SETTLED", invoiceId, error: `${SETTLED_MESSAGE} (Invoice ${docLabel})` }
  }

  const paid = round2(inv.TotalAmt - inv.Balance)
  if (desiredTotal + 0.004 < paid) {
    return {
      ok: false, code: "BELOW_PAID", invoiceId,
      error: `Invoice ${docLabel} has $${paid.toFixed(2)} paid; the order now totals $${desiredTotal.toFixed(2)}. Record the refund or credit in QuickBooks first.`,
    }
  }

  /* 3. Nothing left to bill and nothing paid: void. */
  if (desiredTotal <= 0.004) {
    if (dryRun) return { ok: true, action: "voided", invoiceId, total: 0, message: `Would void ${docLabel} ($${inv.TotalAmt.toFixed(2)} → $0)` }
    await voidInvoice(qbo, conn, inv)
    logger.info(`[qbo-order-sync] order ${label}: voided Invoice ${invoiceId}`)
    return { ok: true, action: "voided", invoiceId, url, total: 0, before: inv.TotalAmt, message: `Invoice ${docLabel} voided (nothing left to bill)` }
  }

  /* 4. Update the lines in place. */
  if (dryRun) {
    return {
      ok: true, action: "updated", invoiceId, total: desiredTotal,
      message: `Would update ${docLabel}: $${inv.TotalAmt.toFixed(2)} → $${desiredTotal.toFixed(2)}${paid > 0 ? ` ($${paid.toFixed(2)} paid)` : ""}`,
    }
  }
  const updated = await updateInvoiceLines(qbo, conn, inv, {
    lines: draft.lines,
    shippingTotal: draft.shippingItemId ? draft.shippingTotal : undefined,
    shippingItemId: draft.shippingItemId,
    taxExempt: true,
  })
  if (Math.abs(updated.totalAmt - desiredTotal) > 0.01) {
    return {
      ok: false, code: "TOTAL_MISMATCH", invoiceId,
      error: `Invoice ${docLabel} updated but QuickBooks shows $${updated.totalAmt.toFixed(2)} where the order totals $${desiredTotal.toFixed(2)}. Check it in QuickBooks.`,
    }
  }
  logger.info(`[qbo-order-sync] order ${label}: Invoice ${invoiceId} $${inv.TotalAmt} → $${updated.totalAmt}`)
  return {
    ok: true, action: "updated", invoiceId, url, total: updated.totalAmt, before: inv.TotalAmt,
    message: `Invoice ${docLabel} updated: $${inv.TotalAmt.toFixed(2)} → $${updated.totalAmt.toFixed(2)}`,
  }
}

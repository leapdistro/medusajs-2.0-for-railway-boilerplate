/**
 * QBO → Medusa: payments recorded in QuickBooks reach the order.
 *
 * QBO owns money (payments, credits, voids); Medusa owns order contents.
 * A QBO change notification (webhook, /hooks/qbo) names an entity; we read
 * it, find the invoice(s) it touches, and bring each linked order up to
 * date: paid / partially paid / voided + balance on order.metadata, a
 * History entry, and — once the invoice is fully paid — the order's
 * Net-terms payment captured so Medusa shows it Paid. No buyer email.
 */
import crypto from "crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"
import { readInvoice, readEntity, type QboInvoice } from "./qbo-api"
import { logOrderHistory } from "./order-history-log"
import type { Logger } from "./qbo-order-push"

export type QboEntityRef = { realmId: string; name: string; id: string; operation: string; key: string }

/** intuit-signature = base64(HMAC-SHA256(raw body, verifier token)). */
export function verifyIntuitSignature(rawBody: Buffer, signature: string, token: string): boolean {
  if (!rawBody?.length || !signature || !token) return false
  const computed = crypto.createHmac("sha256", token).update(rawBody).digest()
  let given: Buffer
  try { given = Buffer.from(signature.trim(), "base64") } catch { return false }
  return given.length === computed.length && crypto.timingSafeEqual(given, computed)
}

/** Both payload shapes: the classic { eventNotifications: [...] } and
 *  the CloudEvents array Intuit is migrating webhooks to. */
export function parseQboNotification(body: any): QboEntityRef[] {
  const out: QboEntityRef[] = []
  if (Array.isArray(body)) {
    for (const ev of body) {
      /* type: "qbo.invoice.updated.v1" */
      const parts = String(ev?.type ?? "").split(".")
      const name = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : ""
      const id = String(ev?.intuitentityid ?? ev?.data?.id ?? "")
      if (!name || !id) continue
      out.push({
        realmId: String(ev?.intuitaccountid ?? ""),
        name: name === "Creditmemo" ? "CreditMemo" : name === "Refundreceipt" ? "RefundReceipt" : name,
        id,
        operation: parts[2] ?? "",
        key: String(ev?.id ?? `${name}:${id}:${ev?.time ?? ""}`),
      })
    }
    return out
  }
  for (const n of body?.eventNotifications ?? []) {
    for (const e of n?.dataChangeEvent?.entities ?? []) {
      if (!e?.name || !e?.id) continue
      out.push({
        realmId: String(n.realmId ?? ""),
        name: String(e.name),
        id: String(e.id),
        operation: String(e.operation ?? ""),
        key: `${e.name}:${e.id}:${e.lastUpdated ?? ""}:${e.operation ?? ""}`,
      })
    }
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Handle one changed QBO entity. */
export async function processQboEntity(scope: any, ref: QboEntityRef, logger: Logger): Promise<void> {
  const qbo: any = scope.resolve(QBO_CONNECTION_MODULE)
  const [conn] = await qbo.listQboConnections({}, { take: 1 })
  if (!conn) return
  if (ref.realmId && String(conn.realm_id) !== ref.realmId) {
    logger.warn(`[qbo-inbound] ignoring ${ref.name} ${ref.id} for realm ${ref.realmId}`)
    return
  }

  const invoiceIds = new Set<string>()
  if (ref.name === "Invoice") {
    invoiceIds.add(ref.id)
  } else if (ref.name === "Payment" || ref.name === "CreditMemo" || ref.name === "RefundReceipt") {
    if (ref.operation.toLowerCase() === "delete") {
      /* A deleted payment can't be read back; the nightly reconcile
       * (phase 4) re-reads every open invoice. */
      logger.info(`[qbo-inbound] ${ref.name} ${ref.id} deleted — left for reconcile`)
      return
    }
    const entity = await readEntity(qbo, conn, ref.name, ref.id).catch(() => null)
    for (const line of entity?.Line ?? []) {
      for (const lt of line?.LinkedTxn ?? []) if (lt?.TxnType === "Invoice" && lt?.TxnId) invoiceIds.add(String(lt.TxnId))
    }
    for (const lt of entity?.LinkedTxn ?? []) if (lt?.TxnType === "Invoice" && lt?.TxnId) invoiceIds.add(String(lt.TxnId))
  } else {
    return
  }

  for (const invoiceId of invoiceIds) {
    await applyInvoiceStatus(scope, conn, invoiceId, ref, logger).catch((e) =>
      logger.warn(`[qbo-inbound] invoice ${invoiceId}: ${e?.message}`),
    )
  }
}

type PayStatus = "unpaid" | "partially_paid" | "paid" | "voided"

async function applyInvoiceStatus(scope: any, conn: any, invoiceId: string, ref: QboEntityRef, logger: Logger): Promise<void> {
  const pg: any = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const found = await pg.raw(
    `select id from "order" where metadata->>'qbo_invoice_id' = ? and deleted_at is null limit 1`,
    [invoiceId],
  )
  const orderId: string | undefined = found?.rows?.[0]?.id
  if (!orderId) return /* invoice created by hand in QBO, not from an order */

  const qbo: any = scope.resolve(QBO_CONNECTION_MODULE)
  let inv: QboInvoice
  try {
    inv = await readInvoice(qbo, conn, invoiceId)
  } catch (e: any) {
    if (ref.name === "Invoice" && ref.operation.toLowerCase() === "delete") {
      await recordStatus(scope, orderId, { status: "voided", paid: 0, balance: 0, total: 0, doc: invoiceId }, `QuickBooks: invoice ${invoiceId} was deleted in QuickBooks`)
    }
    return
  }

  const total = round2(inv.TotalAmt)
  const balance = round2(inv.Balance)
  const paid = round2(total - balance)
  const voided = total <= 0.004 && /\bvoided\b/i.test(inv.PrivateNote ?? "")
  const status: PayStatus = voided ? "voided" : balance <= 0.004 && total > 0 ? "paid" : paid > 0.004 ? "partially_paid" : "unpaid"
  const doc = inv.DocNumber ?? invoiceId

  const summary =
    status === "paid" ? `QuickBooks: invoice ${doc} paid in full (${money(total)}) — order marked paid`
    : status === "partially_paid" ? `QuickBooks: payment received — ${money(paid)} of ${money(total)} paid, balance ${money(balance)}`
    : status === "voided" ? `QuickBooks: invoice ${doc} voided`
    : `QuickBooks: invoice ${doc} unpaid — balance ${money(balance)}`
  const changed = await recordStatus(scope, orderId, { status, paid, balance, total, doc }, summary)
  if (changed && status === "paid") await capturePaidOrder(scope, orderId, logger)
  if (changed) logger.info(`[qbo-inbound] order ${orderId}: ${summary}`)
}

/** Stamp the order + log History, only when something actually changed
 *  (webhooks repeat; an invoice edit fires without a payment change). */
async function recordStatus(
  scope: any,
  orderId: string,
  s: { status: PayStatus; paid: number; balance: number; total: number; doc: string },
  summary: string,
): Promise<boolean> {
  const { Modules } = await import("@medusajs/framework/utils")
  const orderService: any = scope.resolve(Modules.ORDER)
  const [order] = await orderService.listOrders({ id: [orderId] }, { take: 1 })
  if (!order) return false
  const meta = (order.metadata ?? {}) as Record<string, any>
  if (meta.qbo_payment_status === s.status && Number(meta.qbo_amount_paid ?? -1) === s.paid && Number(meta.qbo_balance ?? -1) === s.balance) {
    return false
  }
  await orderService.updateOrders(order.id, {
    metadata: {
      ...meta,
      qbo_payment_status: s.status,
      qbo_amount_paid: s.paid,
      qbo_balance: s.balance,
      qbo_invoice_total: s.total,
      qbo_payment_status_at: new Date().toISOString(),
    },
  })
  await logOrderHistory(scope, orderId, {
    action: `qbo.payment_${s.status}`,
    summary,
    actor: { type: "qbo" },
    details: { invoice_id: s.doc, paid: s.paid, balance: s.balance, total: s.total },
  })
  return true
}

/** Fully paid in QBO → capture the order's open Net-terms (system)
 *  payment so Medusa shows it Paid. Card payments are already captured. */
async function capturePaidOrder(scope: any, orderId: string, logger: Logger): Promise<void> {
  try {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "order",
      fields: ["payment_collections.payments.id", "payment_collections.payments.provider_id",
        "payment_collections.payments.captured_at", "payment_collections.payments.canceled_at"],
      filters: { id: orderId },
    })
    const payments = ((data as any[])[0]?.payment_collections ?? []).flatMap((pc: any) => pc?.payments ?? [])
    const open = payments.filter((p: any) => p?.provider_id === "pp_system_default" && !p?.captured_at && !p?.canceled_at)
    if (open.length === 0) return
    const { capturePaymentWorkflow } = await import("@medusajs/medusa/core-flows")
    for (const p of open) {
      await capturePaymentWorkflow(scope).run({ input: { payment_id: p.id } })
    }
  } catch (e: any) {
    logger.warn(`[qbo-inbound] couldn't mark order ${orderId} paid in Medusa: ${e?.message}`)
    await logOrderHistory(scope, orderId, {
      action: "qbo.mark_paid_failed",
      summary: `Paid in QuickBooks, but Medusa couldn't record the payment: ${e?.message ?? "error"}`,
    })
  }
}

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

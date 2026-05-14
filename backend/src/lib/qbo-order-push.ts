/**
 * Push a Medusa order to QBO as an Invoice (and, for KAJA-paid orders,
 * a Payment that closes the Invoice). Shared between:
 *
 *   - The fulfillment subscriber (auto-push on order fulfilled)
 *   - The manual "Push to QuickBooks" admin retry button
 *
 * Idempotent: bails if `order.metadata.qbo_invoice_id` is already set.
 * Surfaces a descriptive error string on failure so the order widget can
 * render it for the operator.
 */
import {
  baseFromVariantSku,
  createInvoice,
  createPayment,
  findItemBySku,
  findOrCreateCustomer,
  findOrCreateServiceItem,
  findPaymentMethodIdByName,
  findQboTermIdByName,
  getDefaultAccounts,
  invoicePublicUrl,
} from "./qbo-api"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"

export type OrderPushOutcome =
  | { ok: true; invoiceId: string; balance: number; paymentId?: string; url: string }
  | { ok: false; code: "ALREADY_PUSHED"; invoiceId: string }
  | { ok: false; code: "NOT_CONNECTED" | "NO_CUSTOMER" | "MISSING_ITEM" | "API_ERROR"; error: string }

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export async function pushOrderToQbo(
  scope: any,
  orderId: string,
  logger: Logger,
  options: { force?: boolean } = {},
): Promise<OrderPushOutcome> {
  let qbo: any
  try {
    qbo = scope.resolve(QBO_CONNECTION_MODULE)
  } catch {
    return { ok: false, code: "NOT_CONNECTED", error: "QBO module not registered" }
  }
  const connRows = await qbo.listQboConnections({}, { take: 1 }).catch(() => [])
  const conn = connRows[0]
  if (!conn) {
    return { ok: false, code: "NOT_CONNECTED", error: "QBO is not connected — visit /app/quickbooks" }
  }

  /* Load the order with everything we need in one query. */
  const { ContainerRegistrationKeys } = await import("@medusajs/framework/utils")
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "currency_code", "total", "subtotal", "shipping_total",
      "metadata", "created_at",
      "customer.id", "customer.email", "customer.phone", "customer.metadata",
      /* Pull quantity from multiple sources — Medusa v2 line items can
       * have quantity zeroed out after fulfillment cancellation while
       * raw_quantity / detail.quantity retain the original ordered qty. */
      "items.id", "items.title", "items.quantity", "items.raw_quantity",
      "items.unit_price", "items.detail.quantity",
      "items.variant_sku", "items.variant_id", "items.product_title",
      /* variant.inventory_items[].required_quantity is the pool-unit
       * multiplier per variant (QP=1, Half=2, LB=4 for flower). Used
       * to convert order-line variant count → pool-unit count for the
       * QBO invoice so QBO inventory math matches Medusa. */
      "items.variant.metadata",
      "items.variant.inventory_items.required_quantity",
    ],
    filters: { id: orderId },
  })
  const order = (orders as any[])[0]
  if (!order) {
    return { ok: false, code: "API_ERROR", error: `No order ${orderId}` }
  }

  /* Idempotency — skip if already pushed unless explicitly forced. */
  if (order.metadata?.qbo_invoice_id && !options.force) {
    return { ok: false, code: "ALREADY_PUSHED", invoiceId: String(order.metadata.qbo_invoice_id) }
  }

  const customer = order.customer
  if (!customer?.email) {
    return { ok: false, code: "NO_CUSTOMER", error: "Order has no customer or email — push aborted" }
  }
  const customerMeta = (customer.metadata ?? {}) as Record<string, any>

  /* 1. Resolve QBO Customer id — eager path stamps on approval; lazy
   *    fallback finds/creates here. */
  let qboCustomerId = customerMeta.qbo_customer_id as string | undefined
  if (!qboCustomerId) {
    try {
      const created = await findOrCreateCustomer(qbo, conn, {
        businessName: String(customerMeta.business_name ?? "").trim() || customer.email,
        email: customer.email,
        phone: customer.phone ?? null,
        addressLine1: customerMeta.address_line1 ?? null,
        addressLine2: customerMeta.address_line2 ?? null,
        city: customerMeta.city ?? null,
        state: customerMeta.state ?? null,
        zip: customerMeta.zip ?? null,
        country: customerMeta.country ?? "US",
        contactName: customerMeta.contact_name ?? null,
        notes: "Auto-created during order fulfillment push",
      })
      qboCustomerId = created.id
      /* Stamp back so future pushes for this customer skip the lookup. */
      const customerService: any = scope.resolve("customer")
      await customerService.updateCustomers(customer.id, {
        metadata: { ...customerMeta, qbo_customer_id: qboCustomerId },
      })
    } catch (e: any) {
      return { ok: false, code: "API_ERROR", error: `QBO Customer push failed: ${e?.message}` }
    }
  }

  /* 2. Look up the QBO SalesTerm id when customer is Net 15. */
  let salesTermId: string | null = null
  if (customerMeta.payment_terms === "net15") {
    try {
      salesTermId = await findQboTermIdByName(qbo, conn, "Net 15")
    } catch (e: any) {
      logger.warn(`[qbo-order-push] Net 15 term lookup failed: ${e?.message}`)
    }
  }

  /* 3. Map order lines to QBO Item lines. Variant SKU → base SKU →
   *    QBO Item lookup. Any missing item halts the push so operator
   *    can push a receiving (or manually create the QBO item) first. */
  const lines = []
  const missing: string[] = []
  for (const item of order.items ?? []) {
    const vSku = item.variant_sku as string | null
    if (!vSku) {
      missing.push(item.product_title ?? item.title ?? "untitled line")
      continue
    }
    const baseSku = baseFromVariantSku(vSku)
    const found = await findItemBySku(qbo, conn, baseSku).catch(() => null)
    if (!found) {
      missing.push(`${item.product_title ?? item.title ?? "untitled"} (SKU ${baseSku})`)
      continue
    }
    /* Medusa v2 unit_price is already in source-currency dollars
     * (e.g., USD), not cents, and reflects the discounted/effective
     * price. For quantity, fall through multiple shapes: top-level
     * `quantity` (most common), `detail.quantity` (sometimes the
     * fulfillment-aware value), and `raw_quantity.value` (BigNumber
     * source). Cancel-fulfillment workflows can zero out `quantity`
     * while leaving raw_quantity intact. */
    const rawQty = item.raw_quantity?.value ?? item.raw_quantity
    const variantQty = Number(
      (item.quantity != null && Number(item.quantity) > 0 ? item.quantity : null)
        ?? (item.detail?.quantity ?? null)
        ?? rawQty
        ?? 0,
    )
    const variantUnitPrice = Number(item.unit_price ?? 0)

    /* Convert variant units → pool units so QBO inventory math
     * matches Medusa. variant.inventory_items[0].required_quantity
     * is the multiplier: QP=1, Half=2, LB=4 for flower. Defensive
     * fallback to 1 if the relation isn't loaded. The fix preserves
     * the line total: qty × unit = (qty × multiplier) × (unit / multiplier). */
    const reqQtyRaw = item.variant?.inventory_items?.[0]?.required_quantity
    const multiplier = Number(reqQtyRaw ?? 1) || 1
    const qty = variantQty * multiplier
    const unitPrice = multiplier > 1 ? variantUnitPrice / multiplier : variantUnitPrice

    if (qty <= 0 || unitPrice <= 0) {
      /* Surface the raw item shape so we can diagnose v2 query quirks
       * if the multi-source fallback still misses. */
      logger.warn(
        `[qbo-order-push] bad line data: ${JSON.stringify({
          quantity: item.quantity,
          raw_quantity: item.raw_quantity,
          detail_quantity: item.detail?.quantity,
          unit_price: item.unit_price,
          product_title: item.product_title,
        })}`,
      )
      return {
        ok: false,
        code: "API_ERROR",
        error: `Line "${item.product_title ?? item.title ?? "untitled"}" has invalid data (qty=${qty}, unit_price=${unitPrice}). Check the order in Medusa admin.`,
      }
    }
    /* Description anchors on the QBO Item name (which already includes
     * the subcategory: "Strain · Super" for flower, "Strain · THC-A"
     * for pre-rolls) so subcategory is always visible on the line even
     * if the operator's QBO template hides the Item Name column. Then
     * appends the variant the buyer actually picked — e.g.,
     *   "Gold Rose Runtz · Super · 1 × LB"
     *   "Pineapple Express · THC-A · 2 × 30 ct Box"
     * Qty/Rate columns are in pool units (variantQty × multiplier), so
     * without this description an operator reading the invoice would
     * see "4 QPs" without knowing the buyer ordered a single LB. */
    const productName = item.product_title ?? item.title ?? ""
    const variantTitle = item.title && item.title !== productName ? item.title : null
    const variantSegment = variantTitle ? `${variantQty} × ${variantTitle}` : `${variantQty} × unit`
    const description = `${found.name} · ${variantSegment}`
    lines.push({
      itemId: found.id,
      itemName: found.name,
      qty,
      unitPrice: round2(unitPrice),
      description,
    })
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: "MISSING_ITEM",
      error: `QBO Items not found for: ${missing.join("; ")}. Push a receiving for them or create the items manually in QBO.`,
    }
  }
  if (lines.length === 0) {
    return { ok: false, code: "API_ERROR", error: "Order has no eligible line items to push" }
  }

  /* 4. Shipping line — resolve a Service-type "Shipping" Item the first
   *    time we push an invoice with shipping cost, and reuse it
   *    thereafter. Lives separately from product lines so QBO P&L can
   *    split product revenue from shipping revenue. */
  const shippingTotal = Number(order.shipping_total ?? 0)
  let shippingItemId: string | undefined
  if (shippingTotal > 0) {
    try {
      const accounts = await getDefaultAccounts(qbo, conn)
      const shippingItem = await findOrCreateServiceItem(
        qbo,
        conn,
        "Shipping",
        accounts.incomeAccount,
      )
      shippingItemId = shippingItem.id
    } catch (e: any) {
      /* Non-fatal: invoice still pushes without the shipping line.
       * Operator can add manually in QBO if it matters. */
      logger.warn(`[qbo-order-push] shipping item resolve failed for order ${order.id}: ${e?.message}`)
    }
  }

  /* 5. Create the Invoice. */
  const txnDate = new Date().toISOString().slice(0, 10)
  let invoice
  try {
    invoice = await createInvoice(qbo, conn, {
      customerId: qboCustomerId,
      txnDate,
      docNumber: String(order.display_id ?? order.id),
      lines,
      shippingTotal: shippingItemId ? shippingTotal : undefined,
      shippingItemId,
      salesTermId,
      privateNote: `Medusa order ${order.display_id ?? order.id}`,
      taxExempt: true,
    })
  } catch (e: any) {
    return { ok: false, code: "API_ERROR", error: `Invoice create failed: ${e?.message}` }
  }

  /* 6. KAJA-paid path: close the invoice with a Payment so QBO marks
   *    it PAID. Net 15 path skips this — operator records the check
   *    payment manually when it arrives. */
  let paymentId: string | undefined
  if (customerMeta.payment_terms !== "net15") {
    try {
      const paymentMethodId = await findPaymentMethodIdByName(qbo, conn, "Credit Card").catch(() => null)
      const kajaRef =
        (order.metadata?.kaja_transaction_id as string | undefined)
          ?? (order.metadata?.payment_ref as string | undefined)
          ?? undefined
      const payment = await createPayment(qbo, conn, {
        customerId: qboCustomerId,
        invoiceId: invoice.id,
        amount: invoice.totalAmt,
        txnDate,
        paymentMethodId: paymentMethodId ?? undefined,
        refNum: kajaRef,
        privateNote: `Auto-payment for Medusa order ${order.display_id ?? order.id}`,
      })
      paymentId = payment.id
    } catch (e: any) {
      /* Invoice succeeded; payment did not. The Invoice will sit
       * UNPAID — operator can record the payment manually in QBO. */
      logger.warn(`[qbo-order-push] payment create failed for order ${order.id}: ${e?.message}`)
    }
  }

  /* 7. Stamp the order with the QBO ids so future calls are idempotent
   *    + the order widget can display the link. */
  const nowIso = new Date().toISOString()
  try {
    const orderService: any = scope.resolve("order")
    await orderService.updateOrders(order.id, {
      metadata: {
        ...(order.metadata ?? {}),
        qbo_invoice_id: invoice.id,
        qbo_pushed_at: nowIso,
        qbo_payment_id: paymentId ?? null,
        qbo_push_error: null,
      },
    })
  } catch (e: any) {
    logger.warn(`[qbo-order-push] could not stamp order ${order.id} with qbo_invoice_id: ${e?.message}`)
  }
  await qbo.updateQboConnections({
    id: conn.id,
    last_bill_id: invoice.id,
    last_bill_pushed_at: nowIso,
  }).catch(() => {})

  logger.info(`[qbo-order-push] order ${order.id} → Invoice ${invoice.id} (balance ${invoice.balance})`)
  return {
    ok: true,
    invoiceId: invoice.id,
    balance: invoice.balance,
    paymentId,
    url: invoicePublicUrl(conn.environment, conn.realm_id, invoice.id),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

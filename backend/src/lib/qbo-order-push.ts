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
      /* variant.title is the authoritative variant label ("LB", "½",
       * "QP", "30 ct Box"). items.title may have been cart-derived
       * differently — prefer variant.title for invoice descriptions. */
      "items.variant.title",
      /* variant.inventory_items[].required_quantity is the pool-unit
       * multiplier per variant (QP=1, Half=2, LB=4 for flower). Used
       * to convert order-line variant count → pool-unit count for the
       * QBO invoice so QBO inventory math matches Medusa.
       *
       * inputToPool (max required_quantity across ALL of a product's
       * variants) is resolved in a separate shallow product query
       * below — walking it nested through order→items→variant→product
       * →variants→inventory_items.required_quantity silently drops the
       * link-level required_quantity for sibling variants, leaving
       * inputToPool = 1 so each QP got deducted as 1 lb instead of
       * 0.25 lb. */
      "items.variant.metadata",
      "items.variant.inventory_items.required_quantity",
      "items.variant.product.id",
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
  /* Per-product cache of inputToPoolMultiplier (= max
   * required_quantity across the product's variants). Pre-populated via
   * a shallow `product` graph query: walking required_quantity through
   * order→items→variant→product→variants→inventory_items silently drops
   * the link field for sibling variants (Medusa v2 link-walk quirk), so
   * we query it directly from the product entity instead — the same
   * pattern works in inspect-products.ts and /store/mbs/products.
   * Single-variant pre-rolls resolve to 1 → conversions are no-ops. */
  const inputToPoolByProduct = new Map<string, number>()
  const productIds = Array.from(
    new Set(
      ((order.items ?? []) as any[])
        .map((it) => it.variant?.product?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  )
  if (productIds.length > 0) {
    const { data: prods } = await query.graph({
      entity: "product",
      fields: ["id", "variants.inventory_items.required_quantity"],
      filters: { id: productIds },
    })
    for (const p of prods as any[]) {
      const reqs = ((p.variants ?? []) as any[])
        .flatMap((v: any) => (v.inventory_items ?? []).map((ii: any) => Number(ii?.required_quantity ?? 1)))
        .filter((n: number) => Number.isFinite(n) && n > 0)
      inputToPoolByProduct.set(String(p.id), reqs.length > 0 ? Math.max(...reqs) : 1)
    }
  }
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

    /* Convert variant units → QBO Item's input unit (lb for flower,
     * box for pre-rolls).
     *
     * Two multipliers in play:
     *   variantToPool = THIS variant's required_quantity (1/2/4 for
     *                   flower QP/Half/LB; 1 for pre-roll box).
     *   inputToPool   = max required_quantity across all of this
     *                   product's variants (4 for flower since LB
     *                   variant has required_quantity=4; 1 for
     *                   pre-rolls since there's a single variant).
     *
     * QBO Qty = variantQty × variantToPool / inputToPool
     *   1 LB     = 1 × 4 / 4 = 1.0  lb
     *   1 Half   = 1 × 2 / 4 = 0.5  lb
     *   1 QP     = 1 × 1 / 4 = 0.25 lb
     *   1 30ct Box = 1 × 1 / 1 = 1.0 box
     *
     * QBO Rate = variantUnitPrice × inputToPool / variantToPool
     *   1 LB @ $500   → Rate = 500 × 4/4 = $500/lb
     *   1 Half @ $300 → Rate = 300 × 4/2 = $600/lb (volume premium)
     *   1 QP @ $200   → Rate = 200 × 4/1 = $800/lb (more premium)
     * Line total = qty × rate is unchanged (math preserved per-line).
     */
    const reqQtyRaw = item.variant?.inventory_items?.[0]?.required_quantity
    const variantToPool = Number(reqQtyRaw ?? 1) || 1
    /* inputToPool was pre-populated above. Falls back to variantToPool
     * (qty = variantQty, a no-op conversion) only if the product wasn't
     * in the shallow query result — which would mean the product was
     * deleted between order placement and push, an edge case worth a
     * log line. */
    const productId = String((item.variant as any)?.product?.id ?? "")
    const resolvedInputToPool = inputToPoolByProduct.get(productId)
    if (resolvedInputToPool === undefined) {
      logger.warn(
        `[qbo-order-push] inputToPool missing for product ${productId} (line "${item.product_title ?? item.title}") — falling back to variantToPool, QBO qty may be off`,
      )
    }
    const inputToPool = resolvedInputToPool ?? variantToPool
    const qty = (variantQty * variantToPool) / inputToPool
    const unitPrice = (variantUnitPrice * inputToPool) / variantToPool

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
    /* Description shows the strain name + variant the buyer picked
     * (e.g., "Gold Rose Runtz · 1 × LB"). Subcategory already appears
     * in QBO's Item column (Category:SubCategory:ItemName prefix is
     * auto-prepended by QBO from the Item's ParentRef) — repeating it
     * here just adds visual noise.
     *
     * Prefer item.variant.title (authoritative variant label) over
     * item.title (cart-time, sometimes equals product name). Fall
     * through to "× unit" only when neither yields a distinct value. */
    const productName = item.product_title ?? item.title ?? ""
    const variantTitle =
      (item.variant?.title && item.variant.title !== productName ? item.variant.title : null)
      ?? (item.title && item.title !== productName ? item.title : null)
    const variantSegment = variantTitle ? `${variantQty} × ${variantTitle}` : `${variantQty} × unit`
    const description = `${productName} · ${variantSegment}`
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

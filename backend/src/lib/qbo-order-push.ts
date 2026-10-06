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
  findOrCreateItem,
  findOrCreateServiceItem,
  findPaymentMethodIdByName,
  findQboTermIdByName,
  getDefaultAccounts,
  invoicePublicUrl,
  resolveCategoryChain,
} from "./qbo-api"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"
import { billableItemsTotal, billableLines, orderedItemsTotal, unitPriceOf } from "./billable-quantities"

export type OrderPushOutcome =
  | { ok: true; invoiceId: string; balance: number; paymentId?: string; url: string }
  | { ok: false; code: "ALREADY_PUSHED"; invoiceId: string }
  | { ok: false; code: "NOT_CONNECTED" | "NO_CUSTOMER" | "MISSING_ITEM" | "API_ERROR" | "TOTAL_MISMATCH"; error: string }

export type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

export type InvoiceDraft = {
  qboCustomerId: string
  salesTermId: string | null
  lines: Array<{ itemId: string; itemName: string; qty: number; unitPrice: number; description: string }>
  invoiceLinesTotal: number
  shippingTotal: number
  shippingItemId?: string
  cardPayment?: any
  cardTransId?: string
  cardAuthCode?: string
}

/**
 * Build the invoice QBO should hold for this order right now: customer,
 * terms, card-payment facts, item lines (lazy-creating missing Items),
 * shipping, and the total guards. Shared by the first push and every
 * later sync so both apply exactly the same rules.
 */
export async function buildInvoiceDraft(
  scope: any,
  qbo: any,
  conn: any,
  query: any,
  order: any,
  logger: Logger,
  opts: { allowEmpty?: boolean; dryRun?: boolean } = {},
): Promise<InvoiceDraft | Extract<OrderPushOutcome, { ok: false }>> {
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

  /* 2a. Inspect the order's actual payment record(s) — drives both the
   *     SalesTermRef decision (below) and the Payment-create decision
   *     (later). The customer's payment_terms flag is a "policy"; the
   *     order's payment is what actually happened. A Net 15 customer
   *     who paid by card needs a Payment posted; a non-Net-15 customer
   *     paying by check (admin-recorded) doesn't.
   *
   *     Match rule: a captured, non-canceled kaja-authnet payment with
   *     a trans_id on session data == real card capture. Falls back
   *     to order.metadata.kaja_transaction_id / payment_ref for orders
   *     placed via the legacy /store/checkout/kaja-charge route before
   *     the provider cutover (2026-05-18). */
  type OrderPayment = {
    id?: string
    provider_id?: string | null
    amount?: number | { value?: string } | null
    captured_at?: string | null
    canceled_at?: string | null
    data?: Record<string, any> | null
  }
  const orderPayments: OrderPayment[] = ((order.payment_collections ?? []) as Array<{ payments?: OrderPayment[] }>)
    .flatMap((pc) => pc?.payments ?? [])
  const cardPayment = orderPayments.find(
    (p) => p?.provider_id === "pp_kaja-authnet"
      && !!p?.captured_at
      && !p?.canceled_at
      && typeof p?.data?.trans_id === "string",
  )
  const cardTransId =
    (cardPayment?.data?.trans_id as string | undefined)
      ?? (order.metadata?.kaja_transaction_id as string | undefined)
      ?? (order.metadata?.payment_ref as string | undefined)
      ?? undefined
  const cardAuthCode = cardPayment?.data?.auth_code as string | undefined

  /* 2b. SalesTermRef = Net 15 only when the customer is marked Net 15
   *     AND there's no card capture on this order. Otherwise the
   *     invoice would say "Net 15" even though we're about to mark it
   *     paid — confusing for the buyer's records. */
  let salesTermId: string | null = null
  if (customerMeta.payment_terms === "net15" && !cardPayment && !cardTransId) {
    try {
      salesTermId = await findQboTermIdByName(qbo, conn, "Net 15")
    } catch (e: any) {
      logger.warn(`[qbo-order-push] Net 15 term lookup failed: ${e?.message}`)
    }
  }

  /* 3. Map order lines to QBO Item lines. Variant SKU → base SKU →
   *    QBO Item lookup. Missing items get lazy-created inline via the
   *    same findOrCreateItem call used by /admin/qbo/push-bill, so an
   *    invoice can be pushed even when its products' receivings were
   *    never posted to QBO (or the products were created outside the
   *    receiving flow). Only when creation ALSO fails do we surface
   *    MISSING_ITEM to the operator.
   *
   *    Design rationale: previous behavior coupled invoice push to a
   *    manual per-receiving push step, so any gap in that workflow
   *    (missed push, product created outside receiving, new SKU
   *    branch) stalled invoicing with a message the operator couldn't
   *    always act on quickly. findOrCreateItem is idempotent (find
   *    first, create only if missing) so lazy-create is safe against
   *    races between concurrent pushes. */
  const lines = []
  const missing: string[] = []

  /* Memoized helpers used only when a missing item forces us to
   * lazy-create. Amortize the QBO round-trips (accounts + full
   * product_category tree) across all missing items in ONE push
   * without paying the cost when every item already exists. */
  let cachedAccounts: Awaited<ReturnType<typeof getDefaultAccounts>> | null = null
  const getAccounts = async () => {
    if (cachedAccounts) return cachedAccounts
    cachedAccounts = await getDefaultAccounts(qbo, conn)
    return cachedAccounts
  }
  let cachedCategoryMap: Map<string, { name: string; parent_category_id: string | null }> | null = null
  const getCategoryMap = async () => {
    if (cachedCategoryMap) return cachedCategoryMap
    const { data: cats } = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "parent_category_id"],
    })
    const m = new Map<string, { name: string; parent_category_id: string | null }>()
    for (const c of (cats as any[])) {
      m.set(String(c.id), {
        name: String(c.name),
        parent_category_id: c.parent_category_id ? String(c.parent_category_id) : null,
      })
    }
    cachedCategoryMap = m
    return m
  }
  /* Given a product's assigned categories, return the root→leaf name
   * chain for the deepest branch (products are usually assigned to a
   * leaf like `cbd-super`; walking parents yields `Flower > CBD > Super`).
   * Cycle-guarded. */
  const deepestCategoryChain = async (
    assigned: Array<{ id: string; parent_category_id?: string | null }>,
  ): Promise<string[]> => {
    if (assigned.length === 0) return []
    const map = await getCategoryMap()
    const chainFor = (leafId: string): string[] => {
      const names: string[] = []
      const seen = new Set<string>()
      let curId: string | null = leafId
      while (curId && !seen.has(curId)) {
        seen.add(curId)
        const node = map.get(curId)
        if (!node) break
        names.unshift(node.name)
        curId = node.parent_category_id
      }
      return names
    }
    let best: string[] = []
    for (const c of assigned) {
      const chain = chainFor(String(c.id))
      if (chain.length > best.length) best = chain
    }
    return best
  }
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
  /* Billable qty per line (fulfilled, in line units, clamped to
   * ordered; ordered qty when nothing has shipped yet). One rule shared
   * with the capture subscriber and the storefront invoice — see
   * lib/billable-quantities.ts for why fulfillment items can't be summed. */
  const billing = billableLines(order.items, { canceled: order.status === "canceled" })
  const billedByLine = new Map(billing.lines.map((l) => [l.id, l.billed]))

  for (const item of order.items ?? []) {
    const vSku = item.variant_sku as string | null
    if (!vSku) {
      missing.push(item.product_title ?? item.title ?? "untitled line")
      continue
    }
    const baseSku = baseFromVariantSku(vSku)
    let found = await findItemBySku(qbo, conn, baseSku).catch(() => null)
    if (!found && opts.dryRun) {
      missing.push(`${item.product_title ?? item.title ?? "untitled"} (SKU ${baseSku}, would be created)`)
      continue
    }
    if (!found) {
      /* Lazy-create: no QBO Item for this SKU yet. Build one now using
       * the same metadata push-bill would use — strain/product name,
       * SKU, category chain (Flower > CBD > Super, etc.), and an
       * InvStartDate <= the order date so the invoice doesn't get
       * rejected as pre-dating the item. Cost fields intentionally
       * omitted: the invoice line carries its own rate, and the next
       * receiving Bill will post the real landed cost / COGS. If
       * creation fails, fall through to MISSING_ITEM so the operator
       * still gets a clear error. */
      try {
        const productName = (item.product_title ?? item.title ?? baseSku) as string
        const assignedCats = ((item.variant?.product?.categories ?? []) as Array<{
          id: string; parent_category_id?: string | null
        }>)
        const chain = await deepestCategoryChain(assignedCats)
        let parentCategoryId: string | undefined
        if (chain.length > 0) {
          try {
            parentCategoryId = await resolveCategoryChain(qbo, conn, chain)
          } catch (e: any) {
            /* Non-fatal — item still creates at QBO root; operator can
             * re-parent manually if they care about organization. */
            logger.warn(`[qbo-order-push] category resolve failed for ${baseSku}: ${e?.message}`)
          }
        }
        /* Two-level disambiguation ladder for the QBO Name field:
         *   1. bare productName  ("GODFATHER OG")
         *   2. `${name} · ${tier}`  ("GODFATHER OG · Super") — matches
         *      push-bill's fallback pattern; disambiguates from other
         *      TIERS of the same strain.
         *   3. `${name} · ${branch} ${tier}`  ("GODFATHER OG · CBD Super")
         *      — disambiguates from PRE-CBD-SPLIT legacy items that share
         *      the strain name but live at Flower:Super (e.g., the pre-
         *      2026-07 flower tree). Without this level, lazy-create for
         *      new CBD strains that collide with legacy names would fail
         *      the fallback and bubble a MISSING_ITEM to the operator. */
        const tierLabel  = chain.length >= 1 ? chain[chain.length - 1] : ""
        const branchLabel = chain.length >= 3 ? chain[chain.length - 2] : "" // e.g., "CBD" in [Flower, CBD, Super]
        const fallbackName = tierLabel ? `${productName} · ${tierLabel}` : undefined
        const extraFallbackNames = (branchLabel && tierLabel)
          ? [`${productName} · ${branchLabel} ${tierLabel}`]
          : []
        const acc = await getAccounts()
        /* Normalize order.created_at to ISO YYYY-MM-DD. query.graph
         * returns it as a Date object; `String(dateObj).slice(0, 10)`
         * yields the locale-format "Mon Aug 24" prefix which QBO
         * rejects with a 6000 date-range validation error. Route
         * through Date.toISOString() to guarantee ISO. */
        const rawCreatedAt = order.created_at as unknown
        const invStartDate = (() => {
          try {
            const d = rawCreatedAt instanceof Date ? rawCreatedAt : new Date(String(rawCreatedAt ?? ""))
            if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
          } catch { /* fall through */ }
          return new Date().toISOString().slice(0, 10)
        })()
        const created = await findOrCreateItem(qbo, conn, productName, acc, {
          sku: baseSku,
          invStartDate,
          parentCategoryId,
          fallbackName,
          extraFallbackNames,
        })
        found = { id: created.id, name: created.name }
        logger.info(
          `[qbo-order-push] lazy-created QBO Item ${created.id} "${created.name}" for ${productName} (SKU ${baseSku})${
            created.created ? "" : " — found existing"
          }`,
        )
      } catch (e: any) {
        logger.warn(`[qbo-order-push] lazy-create failed for SKU ${baseSku}: ${e?.message}`)
        missing.push(`${item.product_title ?? item.title ?? "untitled"} (SKU ${baseSku})`)
        continue
      }
    }
    /* Medusa v2 unit_price is already in source-currency dollars
     * (e.g., USD), not cents, and reflects the discounted/effective
     * price.
     *
     * Quantity:
     *   - If the order has any fulfillments, use the fulfilled qty for
     *     THIS line. Skip the line entirely when fulfilled qty is 0
     *     (the operator didn't ship it — it will be refunded out).
     *   - If the order has no fulfillments at all (manual push before
     *     fulfillment), fall back to ordered qty. Both via billableLines. */
    const variantQty = billedByLine.get(String(item.id)) ?? 0
    /* Nothing to bill on this line: unshipped, fully returned, or
     * removed by an order edit (quantity 0). */
    if (variantQty <= 0) continue
    const variantUnitPrice = unitPriceOf(item)

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
  if (lines.length === 0 && !opts.allowEmpty) {
    return { ok: false, code: "API_ERROR", error: "Order has no eligible line items to push" }
  }

  /* Total guard — refuse to create an invoice whose goods total differs
   * from what the order says the buyer owes. The unit conversion above
   * reshapes qty/rate per line but must never change a line's value, and
   * no invoice may exceed the ordered goods total. Tolerance covers the
   * per-line cent rounding of fractional-lb rates. */
  const invoiceLinesTotal = round2(lines.reduce((s, l) => s + round2(l.qty * l.unitPrice), 0))
  const expectedLinesTotal = billableItemsTotal(billing.lines)
  const orderedCeiling = orderedItemsTotal(billing.lines)
  const tolerance = 0.01 * lines.length
  if (
    Math.abs(invoiceLinesTotal - expectedLinesTotal) > tolerance
    || invoiceLinesTotal > orderedCeiling + tolerance
  ) {
    logger.error(
      `[qbo-order-push] TOTAL_MISMATCH order ${order.display_id ?? order.id}: invoice lines $${invoiceLinesTotal} vs billable $${expectedLinesTotal} (ordered $${orderedCeiling}) — invoice NOT created`,
    )
    return {
      ok: false,
      code: "TOTAL_MISMATCH",
      error: `Invoice lines total $${invoiceLinesTotal.toFixed(2)} doesn't match the order's billable total $${expectedLinesTotal.toFixed(2)} (ordered $${orderedCeiling.toFixed(2)}). Invoice was NOT created — check the order's quantities before retrying.`,
    }
  }

  /* Independent ceiling: Medusa's own current order total (reflects
   * order edits and received returns). Catches any rule above drifting
   * from what Medusa says the buyer owes — the class of bug behind
   * orders 317/332 (4x qty) and 340 (pre-edit prices). */
  const medusaCurrentTotal = Number(
    order.summary?.current_order_total ?? order.summary?.totals?.current_order_total ?? NaN,
  )
  if (Number.isFinite(medusaCurrentTotal)) {
    const goodsCeiling = round2(medusaCurrentTotal - Number(order.shipping_total ?? 0))
    if (invoiceLinesTotal > Math.max(0, goodsCeiling) + tolerance + 0.01) {
      logger.error(
        `[qbo-order-push] TOTAL_MISMATCH order ${order.display_id ?? order.id}: invoice lines $${invoiceLinesTotal} exceed Medusa's current goods total $${goodsCeiling}`,
      )
      return {
        ok: false,
        code: "TOTAL_MISMATCH",
        error: `Invoice lines total $${invoiceLinesTotal.toFixed(2)} is more than Medusa's current order total for goods ($${goodsCeiling.toFixed(2)}). Nothing was sent to QuickBooks.`,
      }
    }
  }

  /* 4. Shipping line — resolve a Service-type "Shipping" Item the first
   *    time we push an invoice with shipping cost, and reuse it
   *    thereafter. Lives separately from product lines so QBO P&L can
   *    split product revenue from shipping revenue. */
  /* Nothing billable (cancelled / fully returned) means no shipping either. */
  const shippingTotal = lines.length > 0 ? Number(order.shipping_total ?? 0) : 0
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

  return {
    qboCustomerId: qboCustomerId as string,
    salesTermId,
    lines,
    invoiceLinesTotal,
    shippingTotal,
    shippingItemId,
    cardPayment,
    cardTransId,
    cardAuthCode,
  }
}

/** Resolve the QBO connection and load the order with every field the
 *  push and the sync need. */
export async function loadQboOrder(
  scope: any,
  orderId: string,
): Promise<{ qbo: any; conn: any; query: any; order: any } | Extract<OrderPushOutcome, { ok: false }>> {
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
      /* Billable qty + current (edited) price — see lib/billable-quantities.ts. */
      "items.detail.unit_price",
      "items.detail.fulfilled_quantity",
      "items.detail.return_received_quantity",
      /* status: a cancelled order bills nothing. summary: Medusa's own
       * current order total — the independent ceiling for any invoice. */
      "status", "summary",
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
      /* product.categories drives QBO Item Category placement on
       * lazy-create. Without these fields the walk falls back to
       * root-level items (see the missing-item branch below). */
      "items.variant.product.categories.id",
      "items.variant.product.categories.name",
      "items.variant.product.categories.parent_category_id",
      /* Actual payment state on the order — drives the QBO Payment
       * decision below. We can't trust customer.metadata.payment_terms
       * alone: an admin can grant a buyer Net 15 yet that buyer's
       * older order was paid by card. Read the payment record. */
      "payment_collections.payments.id",
      "payment_collections.payments.provider_id",
      "payment_collections.payments.amount",
      "payment_collections.payments.captured_at",
      "payment_collections.payments.canceled_at",
      "payment_collections.payments.data",
    ],
    filters: { id: orderId },
  })
  const order = (orders as any[])[0]
  if (!order) {
    return { ok: false, code: "API_ERROR", error: `No order ${orderId}` }
  }

  return { qbo, conn, query, order }
}

export async function pushOrderToQbo(
  scope: any,
  orderId: string,
  logger: Logger,
  options: { force?: boolean } = {},
): Promise<OrderPushOutcome> {
  const loaded = await loadQboOrder(scope, orderId)
  if ("ok" in loaded) return loaded
  const { qbo, conn, query, order } = loaded

  /* Idempotency — skip if already pushed unless explicitly forced. */
  if (order.metadata?.qbo_invoice_id && !options.force) {
    return { ok: false, code: "ALREADY_PUSHED", invoiceId: String(order.metadata.qbo_invoice_id) }
  }

  const draft = await buildInvoiceDraft(scope, qbo, conn, query, order, logger)
  if ("ok" in draft) return draft
  const {
    qboCustomerId, salesTermId, lines, invoiceLinesTotal,
    shippingTotal, shippingItemId, cardPayment, cardTransId, cardAuthCode,
  } = draft

  /* 5. Create the Invoice.
   *    DocNumber strategy: deterministic mapping from Medusa display_id
   *    → "MBS-<n>". Lets the accountant see the source order at a glance
   *    AND eliminates drift between Medusa and QBO when invoices get
   *    deleted/re-pushed during testing — same order always gets the
   *    same DocNumber. The "MBS-" prefix prevents collision with any
   *    invoices manually created directly in QBO (those use plain
   *    numeric DocNumbers).
   *
   *    Collision retry: if "MBS-25" already exists (e.g., re-push on top
   *    of an undeleted prior invoice), retry with "MBS-25-2", "MBS-25-3"
   *    up to a small cap. After that we give up and surface the error —
   *    operator should delete the prior QBO invoice manually. */
  /* TxnDate = the order's created_at (truncated to YYYY-MM-DD). Previously
   * we used new Date() at push time, which made the QBO invoice show the
   * fulfillment date rather than the order date — and crossed UTC midnight
   * could even bump it forward a day from the operator's local view. */
  const orderCreatedIso = order.created_at
    ? new Date(order.created_at).toISOString()
    : new Date().toISOString()
  const txnDate = orderCreatedIso.slice(0, 10)
  const baseDocNumber = `MBS-${order.display_id ?? order.id}`
  let invoice: Awaited<ReturnType<typeof createInvoice>> | undefined
  let lastError: string | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    const docNumber = attempt === 0 ? baseDocNumber : `${baseDocNumber}-${attempt + 1}`
    try {
      invoice = await createInvoice(qbo, conn, {
        customerId: qboCustomerId,
        txnDate,
        docNumber,
        lines,
        shippingTotal: shippingItemId ? shippingTotal : undefined,
        shippingItemId,
        salesTermId,
        privateNote: `Medusa order ${order.display_id ?? order.id}`,
        taxExempt: true,
      })
      break
    } catch (e: any) {
      const msg = String(e?.message ?? "")
      lastError = msg
      /* Duplicate DocNumber Error = code 6140. Retry with -N suffix. */
      if (/Duplicate Document Number|\b6140\b/.test(msg)) {
        logger.info(`[qbo-order-push] DocNumber "${docNumber}" exists in QBO — retrying with suffix`)
        continue
      }
      /* Any other error — bail. */
      return { ok: false, code: "API_ERROR", error: `Invoice create failed: ${msg}` }
    }
  }
  if (!invoice) {
    return {
      ok: false,
      code: "API_ERROR",
      error: `Invoice create failed after 5 DocNumber collision retries (base "${baseDocNumber}"). Last error: ${lastError ?? "unknown"}`,
    }
  }

  /* Post-create guard — QBO computes TotalAmt itself. If it disagrees
   * with ours we skip the auto-payment, still stamp the invoice id (so
   * the widget links it), and report failure so the operator gets a bell. */
  const expectedInvoiceTotal = round2(invoiceLinesTotal + (shippingItemId ? shippingTotal : 0))
  const totalMismatch = Math.abs(Number(invoice.totalAmt) - expectedInvoiceTotal) > 0.01
  if (totalMismatch) {
    logger.error(
      `[qbo-order-push] TOTAL_MISMATCH order ${order.display_id ?? order.id}: QBO Invoice ${invoice.id} TotalAmt $${invoice.totalAmt} vs expected $${expectedInvoiceTotal}`,
    )
  }

  /* 6. Card-paid path: close the invoice with a Payment so QBO marks
   *    it PAID. The decision is driven by the ACTUAL order payment
   *    (`cardPayment` / `cardTransId` resolved above) — NOT the
   *    customer's `payment_terms` flag. A Net-15-flagged customer who
   *    paid by card still needs a Payment posted; that flag is a
   *    "what they're allowed to do later" policy, not "what this
   *    specific order did."
   *
   *    No card payment → invoice stays UNPAID. Operator records the
   *    check / wire / manual payment in QBO when it arrives (or marks
   *    it manually). */
  let paymentId: string | undefined
  if ((cardPayment || cardTransId) && !totalMismatch) {
    try {
      const paymentMethodId = await findPaymentMethodIdByName(qbo, conn, "Credit Card").catch(() => null)
      const payment = await createPayment(qbo, conn, {
        customerId: qboCustomerId,
        invoiceId: invoice.id,
        amount: invoice.totalAmt,
        txnDate,
        paymentMethodId: paymentMethodId ?? undefined,
        refNum: cardTransId,
        privateNote: cardAuthCode
          ? `Auto-payment for Medusa order ${order.display_id ?? order.id} · auth ${cardAuthCode}`
          : `Auto-payment for Medusa order ${order.display_id ?? order.id}`,
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
        /* DocNumber is the human-facing QBO Invoice number (auto-
         * incremented unless we passed docNumber). Stamp it so the
         * customer-facing PDF (storefront) can render the SAME number
         * QBO shows the accountant. Null when QBO didn't return one. */
        qbo_doc_number: invoice.docNumber ?? null,
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

  if (totalMismatch) {
    return {
      ok: false,
      code: "TOTAL_MISMATCH",
      error: `QBO Invoice ${invoice.docNumber ?? invoice.id} was created with total $${Number(invoice.totalAmt).toFixed(2)} but the order total is $${expectedInvoiceTotal.toFixed(2)}. Fix the invoice in QBO.`,
    }
  }

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

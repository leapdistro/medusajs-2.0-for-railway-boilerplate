import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { capturePaymentWorkflow, completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { chargeWithOpaqueData, voidTransaction } from "../../../../lib/kaja-authnet"

/**
 * POST /store/checkout/kaja-charge
 * Body: { cart_id, opaqueData: { dataDescriptor, dataValue } }
 *
 * Atomic charge + cart-complete for KAJA-paid orders. Flow:
 *   1. Load cart + validate it's open with a positive total
 *   2. Charge card via Authorize.net authCaptureTransaction
 *   3. Complete cart (creates Order)
 *   4. Stamp order.metadata with kaja_transaction_id + auth_code + amount
 *      (qbo-order-push.ts reads these on fulfillment → QBO Payment lands
 *      with the real txn id as PaymentRefNum)
 *
 * Failure modes:
 *   - Charge fails (declined, bad card, network) → 402, no order created
 *   - Charge succeeds but cart.complete fails → void the charge inline so
 *     the customer isn't billed for an order that doesn't exist. If the
 *     void ALSO fails, log critical so operator can void manually before
 *     nightly settlement.
 *
 * Storefront proxies here via /api/checkout/kaja-charge (which then
 * fires the order-confirmation emails on success — same pattern as
 * /api/checkout/complete).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const body = (req.body ?? {}) as {
    cart_id?: string
    opaqueData?: { dataDescriptor?: string; dataValue?: string }
  }
  const cartId = body.cart_id?.trim()
  const opaque = body.opaqueData
  if (!cartId) return res.status(400).json({ ok: false, message: "cart_id required" })
  if (!opaque?.dataDescriptor || !opaque?.dataValue) {
    return res.status(400).json({ ok: false, message: "opaqueData (dataDescriptor + dataValue) required" })
  }

  /* 1. Load cart with totals + addresses + completed flag. */
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: carts } = await query.graph({
    entity: "cart",
    fields: [
      "id", "completed_at", "total", "currency_code", "email",
      "billing_address.first_name", "billing_address.last_name",
      "billing_address.company", "billing_address.address_1",
      "billing_address.city", "billing_address.province",
      "billing_address.postal_code", "billing_address.country_code",
      "billing_address.phone",
    ],
    filters: { id: cartId },
  })
  const cart = (carts as any[])[0]
  if (!cart) return res.status(404).json({ ok: false, message: "Cart not found" })
  if (cart.completed_at) return res.status(409).json({ ok: false, message: "Cart already completed" })

  const amount = Number(cart.total ?? 0)
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, message: "Cart total is zero or invalid" })
  }

  /* 2. Charge via Authorize.net (auth + capture in one round-trip). */
  const charge = await chargeWithOpaqueData({
    amount,
    opaqueData: {
      dataDescriptor: opaque.dataDescriptor,
      dataValue: opaque.dataValue,
    },
    /* Use last 12 chars of cart id as a short invoice reference for the
     * Authorize.net dashboard. Will be replaced by the real Medusa
     * order display_id in QBO downstream. */
    invoiceNumber: cartId.slice(-12),
    customerEmail: cart.email ?? undefined,
    billingAddress: cart.billing_address ? {
      firstName: cart.billing_address.first_name,
      lastName: cart.billing_address.last_name,
      company: cart.billing_address.company,
      address: cart.billing_address.address_1,
      city: cart.billing_address.city,
      state: cart.billing_address.province,
      zip: cart.billing_address.postal_code,
      country: (cart.billing_address.country_code ?? "us").toUpperCase(),
    } : undefined,
  })

  if (charge.ok !== true) {
    const code = charge.code
    const message = charge.message
    logger.warn(`[kaja-charge] charge failed for cart ${cartId}: ${code} ${message}`)
    /* 402 Payment Required maps to "card declined / payment problem"
     * which is what the storefront should surface to the buyer. */
    return res.status(402).json({ ok: false, code, message })
  }

  /* 3. Complete the cart — creates the Order. */
  let orderId: string
  let displayId: number | null = null
  try {
    const { result } = await completeCartWorkflow(req.scope).run({
      input: { id: cartId },
    })
    orderId = (result as any).id
    displayId = (result as any).display_id ?? null
    if (!orderId) throw new Error("completeCartWorkflow returned no order id")
  } catch (e: any) {
    logger.error(
      `[kaja-charge] cart complete FAILED after successful charge ` +
      `(cart=${cartId}, transId=${charge.transId}): ${e?.message}`,
    )
    const voided = await voidTransaction(charge.transId)
    if (!voided.ok) {
      logger.error(
        `[kaja-charge] CRITICAL — void of transId ${charge.transId} also failed: ` +
        `${voided.error} — manual void required before nightly settlement`,
      )
    }
    return res.status(500).json({
      ok: false,
      code: "CART_COMPLETE_FAILED",
      message: e?.message ?? "Order could not be created",
      voided: voided.ok,
    })
  }

  /* 4. Stamp the Order so qbo-order-push reads the txn id on fulfillment.
   *    Also captures display_id here — completeCartWorkflow's result
   *    doesn't include the auto-incremented display_id (only the id),
   *    so we read it from the order record itself. Non-fatal — if the
   *    stamp fails the order still exists; operator can edit metadata
   *    in admin. The display_id read still succeeds in that case. */
  try {
    const orderService: any = req.scope.resolve(Modules.ORDER)
    const [order] = await orderService.listOrders({ id: [orderId] }, { take: 1 })
    if (order) {
      if (order.display_id != null) displayId = Number(order.display_id)
      await orderService.updateOrders(orderId, {
        metadata: {
          ...(order.metadata ?? {}),
          kaja_transaction_id: charge.transId,
          kaja_auth_code: charge.authCode,
          kaja_amount_captured: amount.toFixed(2),
          kaja_avs_result: charge.avsResult ?? null,
          kaja_cvv_result: charge.cvvResult ?? null,
          /* Legacy alias — qbo-order-push.ts also reads `payment_ref`. */
          payment_ref: charge.transId,
          payment_captured_at: new Date().toISOString(),
        },
      })
    }
  } catch (e: any) {
    logger.warn(`[kaja-charge] could not stamp metadata on order ${orderId}: ${e?.message}`)
  }

  /* 5. Capture the Medusa payment so admin doesn't show a misleading
   *    "Capture Payment" button. The actual money was captured via
   *    Authorize.net's authCaptureTransaction above; this is purely a
   *    state-sync inside Medusa. pp_system_default's capturePayment is
   *    a no-op — it just flips the local payment record from
   *    "authorized" to "captured" so the order shows Paid in admin.
   *
   *    Non-fatal: the order + charge are both already finalized; this
   *    is cosmetic. If multiple payments exist (split-pay scenario,
   *    not currently used), capture each. */
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "payment_collections.payments.id", "payment_collections.payments.captured_at"],
      filters: { id: orderId },
    })
    const paymentIds: string[] = (((orders as any[])[0]?.payment_collections ?? []) as any[])
      .flatMap((pc) => (pc?.payments ?? []) as any[])
      .filter((p) => p?.id && !p.captured_at)
      .map((p) => String(p.id))

    for (const pid of paymentIds) {
      await capturePaymentWorkflow(req.scope).run({
        input: { payment_id: pid, amount },
      })
    }
    if (paymentIds.length > 0) {
      logger.info(`[kaja-charge] captured ${paymentIds.length} Medusa payment(s) for order ${orderId}`)
    }
  } catch (e: any) {
    logger.warn(`[kaja-charge] Medusa payment capture sync failed for order ${orderId}: ${e?.message} (cosmetic — money already captured externally)`)
  }

  logger.info(`[kaja-charge] cart ${cartId} → order ${orderId} (display=${displayId}) · $${amount.toFixed(2)} via transId ${charge.transId}`)
  return res.json({
    ok: true,
    orderId,
    displayId,
    transId: charge.transId,
    authCode: charge.authCode,
    amount: amount.toFixed(2),
  })
}

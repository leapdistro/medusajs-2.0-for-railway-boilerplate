import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  beginOrderEditOrderWorkflow,
  cancelBeginOrderEditWorkflow,
  confirmOrderEditRequestWorkflow,
  createOrderEditShippingMethodWorkflow,
  requestOrderEditRequestWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * POST /admin/orders/:id/shipping-charge
 * Body: { amount: number, shipping_option_id: string }
 *
 * Adds a shipping charge to an existing order — e.g. a Local Pickup
 * order the operator ends up shipping. Medusa's admin has no control
 * for this, but its order-edit API does: begin → add a shipping method
 * at a custom amount → request → confirm. The framework recomputes the
 * order totals, and the confirm emits `order-edit.confirmed`, which the
 * QBO sync subscriber turns into a Shipping line on the invoice (or
 * picks up at first push if the order hasn't been invoiced yet).
 *
 * The shipping option only supplies the method's name and provider; the
 * amount is always the operator's. Existing shipping methods are left
 * alone — the order keeps its history and the new charge is added.
 *
 * Refused when the QBO invoice is fully paid: this path is listed in
 * ORDER_CHANGE_ROUTES (middlewares.ts) so qboSettledGuard runs first.
 *
 * Audit: appends `{ amount, option, by, at }` to
 * order.metadata.shipping_charges.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const actorId = (req as any).auth_context?.actor_id ?? null

  const orderId = req.params.id
  const body = (req.body ?? {}) as { amount?: number; shipping_option_id?: string }
  const amount = Math.round(Number(body.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, message: "amount must be a positive number" })
  }
  if (!body.shipping_option_id) {
    return res.status(400).json({ ok: false, message: "shipping_option_id is required" })
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "status", "canceled_at", "metadata"],
    filters: { id: orderId },
  })
  const order = (orders as any[])[0]
  if (!order) return res.status(404).json({ ok: false, message: `No order ${orderId}` })
  if (order.canceled_at || order.status === "canceled") {
    return res.status(400).json({ ok: false, message: "Order is canceled" })
  }

  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "name"],
    filters: { id: body.shipping_option_id },
  })
  const option = (options as any[])[0]
  if (!option) {
    return res.status(400).json({ ok: false, message: `No shipping option ${body.shipping_option_id}` })
  }

  /* Framework path. Any failure between begin and confirm rolls the
   * edit back so a retry doesn't collide with a stale order change. */
  let begun = false
  try {
    await beginOrderEditOrderWorkflow(req.scope).run({
      input: { order_id: orderId, created_by: actorId } as any,
    })
    begun = true

    await createOrderEditShippingMethodWorkflow(req.scope).run({
      input: {
        order_id: orderId,
        shipping_option_id: option.id,
        custom_amount: amount,
      } as any,
    })

    await requestOrderEditRequestWorkflow(req.scope).run({
      input: { order_id: orderId, requested_by: actorId } as any,
    })

    await confirmOrderEditRequestWorkflow(req.scope).run({
      input: { order_id: orderId, confirmed_by: actorId } as any,
    })
  } catch (e: any) {
    if (begun) {
      try {
        await cancelBeginOrderEditWorkflow(req.scope).run({ input: { order_id: orderId } as any })
      } catch (cancelErr: any) {
        logger.warn(`[order-shipping-charge] rollback failed for order ${orderId}: ${cancelErr?.message}`)
      }
    }
    logger.error(`[order-shipping-charge] failed for order ${orderId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Adding the shipping charge failed" })
  }

  try {
    /* Re-read metadata: the confirm above kicks off the QBO sync, which
     * stamps its own keys here. Writing back the snapshot from before
     * the edit would wipe them. */
    const { data: fresh } = await query.graph({
      entity: "order",
      fields: ["metadata"],
      filters: { id: orderId },
    })
    const metadata = ((fresh as any[])[0]?.metadata ?? {}) as Record<string, any>
    const charges = Array.isArray(metadata.shipping_charges) ? [...metadata.shipping_charges] : []
    charges.push({ amount, option: option.name, by: actorId, at: new Date().toISOString() })
    await orderService.updateOrders(orderId, {
      metadata: { ...metadata, shipping_charges: charges },
    })
  } catch (e: any) {
    /* Non-fatal — the charge is already on the order via the edit. */
    logger.warn(`[order-shipping-charge] audit metadata write failed for order ${orderId}: ${e?.message}`)
  }

  logger.info(`[order-shipping-charge] order #${order.display_id}: +${amount.toFixed(2)} ${option.name}`)
  return res.json({ ok: true, amount, option: option.name })
}

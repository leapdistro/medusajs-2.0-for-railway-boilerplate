import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ChangeActionType, ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  beginOrderEditOrderWorkflow,
  cancelBeginOrderEditWorkflow,
  confirmOrderEditRequestWorkflow,
  createOrderChangeActionsWorkflow,
  createOrderEditShippingMethodWorkflow,
  requestOrderEditRequestWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * POST /admin/orders/:id/shipping-charge
 * Body: { amount: number, shipping_option_id: string, mode?: "add" | "set", preview?: boolean }
 *
 * mode "add" (default) adds a shipping charge to an existing order — e.g.
 * a Local Pickup order the operator ends up shipping.
 *
 * mode "set" makes `amount` the order's whole shipping: in one order edit
 * it removes every current shipping method (SHIPPING_REMOVE actions,
 * recorded at minus their amount) and adds one at `amount` (none when 0,
 * i.e. free shipping). Medusa's order-edit workflows can only remove
 * methods added in the same edit; the order engine itself applies
 * SHIPPING_REMOVE, dropping the method from the new order version and
 * recomputing the summary. Before confirming, the edit is previewed and
 * its shipping total must equal `amount`, else it's cancelled.
 *
 * preview: true returns the shipping and order totals the change would
 * produce, worked out from the order as it stands. It opens no order
 * edit: a shipping method only exists as a real row, and Medusa's
 * cancelBeginOrderEditWorkflow (2.13) deletes SHIPPING_ADD methods by
 * ACTION id, so a cancelled edit leaves its method on the order's next
 * version (order 424 got a stray $65 that way). For the same reason any
 * cancel here also soft-deletes the methods the edit created.
 * Medusa's admin has no control
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
  const body = (req.body ?? {}) as { amount?: number; shipping_option_id?: string; mode?: string; preview?: boolean }
  const mode = body.mode === "set" ? "set" : "add"
  const preview = body.preview === true
  const amount = Math.round(Number(body.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount < 0 || (mode === "add" && amount === 0)) {
    return res.status(400).json({ ok: false, message: mode === "set" ? "amount must be 0 or more" : "amount must be a positive number" })
  }
  if (!body.shipping_option_id) {
    return res.status(400).json({ ok: false, message: "shipping_option_id is required" })
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "status", "canceled_at", "metadata", "shipping_total", "total", "shipping_methods.id", "shipping_methods.amount"],
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

  const num = (v: any) => Number(v?.numeric ?? v ?? 0)
  const before = { shipping: num(order.shipping_total), total: num(order.total) }
  const round = (n: number) => Math.round(n * 100) / 100
  const expected = mode === "set" ? amount : round(before.shipping + amount)
  let after = { shipping: expected, total: round(before.total - before.shipping + expected) }

  if (preview) {
    return res.json({ ok: true, preview: true, mode, amount, before, after })
  }

  /* Shipping methods this edit created — soft-deleted if the edit is
   * cancelled (see the note on Medusa's cancel above). */
  const createdMethodIds = async (changeId: string): Promise<string[]> => {
    const { data: changes } = await query.graph({
      entity: "order_change",
      fields: ["id", "actions.action", "actions.reference_id"],
      filters: { id: changeId },
    })
    return (((changes as any[])[0]?.actions ?? []) as any[])
      .filter((a) => a.action === ChangeActionType.SHIPPING_ADD && a.reference_id)
      .map((a) => a.reference_id)
  }
  let changeId: string | null = null

  /* Framework path. Any failure between begin and confirm rolls the
   * edit back so a retry doesn't collide with a stale order change. */
  let begun = false
  try {
    const { result: change } = await beginOrderEditOrderWorkflow(req.scope).run({
      input: { order_id: orderId, created_by: actorId } as any,
    })
    begun = true
    changeId = (change as any).id

    if (mode === "set") {
      const current = (order.shipping_methods ?? []) as Array<{ id: string; amount: unknown }>
      if (current.length > 0) {
        await createOrderChangeActionsWorkflow(req.scope).run({
          input: current.map((m) => ({
            action: ChangeActionType.SHIPPING_REMOVE,
            reference: "order_shipping_method",
            reference_id: m.id,
            order_change_id: (change as any).id,
            order_id: orderId,
            amount: -Number(m.amount ?? 0),
          })) as any,
        })
      }
    }

    if (amount > 0) {
      await createOrderEditShippingMethodWorkflow(req.scope).run({
        input: {
          order_id: orderId,
          shipping_option_id: option.id,
          custom_amount: amount,
        } as any,
      })
    }

    /* What the order would look like once confirmed. */
    const projected: any = await orderService.previewOrderChange(orderId)
    const projectedShipping = ((projected?.shipping_methods ?? []) as any[])
      .reduce((sum, m) => sum + Number(m?.amount ?? 0), 0)
    const projectedTotal = num(projected?.summary?.current_order_total ?? projected?.total)
    if (Math.abs(round(projectedShipping) - expected) > 0.005) {
      throw new Error(`The edit would leave shipping at ${round(projectedShipping).toFixed(2)}, not ${expected.toFixed(2)}; nothing was changed.`)
    }
    after = { shipping: round(projectedShipping), total: projectedTotal }

    await requestOrderEditRequestWorkflow(req.scope).run({
      input: { order_id: orderId, requested_by: actorId } as any,
    })

    await confirmOrderEditRequestWorkflow(req.scope).run({
      input: { order_id: orderId, confirmed_by: actorId } as any,
    })
  } catch (e: any) {
    if (begun) {
      try {
        const created = changeId ? await createdMethodIds(changeId) : []
        await cancelBeginOrderEditWorkflow(req.scope).run({ input: { order_id: orderId } as any })
        if (created.length > 0) await orderService.softDeleteOrderShippingMethods(created)
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
    charges.push({ amount, mode, before: before.shipping, option: option.name, by: actorId, at: new Date().toISOString() })
    await orderService.updateOrders(orderId, {
      metadata: { ...metadata, shipping_charges: charges },
    })
  } catch (e: any) {
    /* Non-fatal — the charge is already on the order via the edit. */
    logger.warn(`[order-shipping-charge] audit metadata write failed for order ${orderId}: ${e?.message}`)
  }

  logger.info(`[order-shipping-charge] order #${order.display_id}: ${mode === "set" ? `shipping set to ${amount.toFixed(2)} (was ${before.shipping.toFixed(2)})` : `+${amount.toFixed(2)}`} ${option.name}`)
  return res.json({ ok: true, mode, amount, option: option.name, before, after })
}

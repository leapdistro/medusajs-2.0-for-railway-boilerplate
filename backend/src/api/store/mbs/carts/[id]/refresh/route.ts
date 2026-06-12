import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refreshCartItemsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * POST /store/mbs/carts/:id/refresh
 *
 * Re-evaluates the cart's line-item prices (+ promotions, taxes,
 * shipping methods) against the current customer context. Medusa
 * snapshots `line_item.unit_price` at add-to-cart time, so a buyer
 * whose pricing mode (Distro / Owner Stores / default) changed after
 * they added items would otherwise see stale prices in the cart.
 *
 * Storefront's `getCart` calls this before reading the cart so the
 * view always reflects today's pricing context.
 *
 * Idempotent — re-running on an unchanged cart is a no-op.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const cartId = req.params.id
  if (!cartId) {
    return res.status(400).json({ ok: false, message: "Missing cart id" })
  }

  try {
    await refreshCartItemsWorkflow(req.scope).run({ input: { cart_id: cartId } })
    return res.json({ ok: true })
  } catch (e: any) {
    /* Soft-fail — the storefront treats this as best-effort. A
     * failure here doesn't block cart display; it just means the
     * buyer might see stale prices until something else updates
     * the cart (add item, change qty, complete). */
    logger.warn(`[carts/refresh] ${cartId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Refresh failed" })
  }
}

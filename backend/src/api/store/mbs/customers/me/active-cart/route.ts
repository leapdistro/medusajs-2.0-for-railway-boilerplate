import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * GET /store/mbs/customers/me/active-cart
 *
 * Returns the most recent INCOMPLETE cart for the signed-in customer,
 * or `cart: null` when they have none. Powers the storefront's
 * cart-resume-on-sign-in flow — buyer signs out, signs back in, and
 * their cart re-appears.
 *
 * Why custom: Medusa's native /store/customers/me doesn't expand
 * carts, and /store/carts requires a cart_id. This route is the
 * "give me my latest active cart" affordance we need.
 *
 * Auth: requires the customer Bearer token (publishable key alone won't
 * resolve req.auth_context.actor_id). 401 if anonymous — anonymous
 * carts can't exist on this storefront (ATC is gated behind sign-in
 * at /api/cart) so an anonymous caller has no expected use case here.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = (req as unknown as { auth_context?: { actor_id?: string } })
    .auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  try {
    /* Filter: belongs to this customer + not yet completed (incomplete
     * carts are the only ones eligible to "resume"). Sort by updated_at
     * descending + take 1 — last-touched wins if the buyer somehow has
     * multiple incomplete carts from different sessions. */
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: ["id", "updated_at", "items.id"],
      filters: {
        customer_id: customerId,
        completed_at: null,
      },
      pagination: {
        take: 1,
        order: { updated_at: "DESC" },
      },
    })

    const cart = (carts as Array<{ id: string; updated_at: string; items?: any[] }>)[0]
    if (!cart) {
      return res.json({ ok: true, cart: null })
    }
    return res.json({
      ok: true,
      cart: {
        id: cart.id,
        updated_at: cart.updated_at,
        item_count: Array.isArray(cart.items) ? cart.items.length : 0,
      },
    })
  } catch (e: any) {
    /* Soft-fail: storefront should treat "couldn't resolve" the same
     * as "no active cart" and start fresh. Don't 500 the sign-in flow
     * just because cart lookup blew up. */
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    logger.warn(`[active-cart] lookup failed for customer ${customerId}: ${e?.message}`)
    return res.json({ ok: true, cart: null })
  }
}

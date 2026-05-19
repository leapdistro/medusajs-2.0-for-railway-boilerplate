import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { getCustomerProfile, type SavedCard } from "../../../../../../lib/kaja-authnet"

/**
 * GET /store/mbs/customers/me/payment-methods
 *
 * Lists the signed-in buyer's saved cards (CIM Payment Profiles).
 * Returns an empty array when:
 *   - customer.metadata.kaja_cim_profile_id isn't set (buyer never
 *     saved a card → no CIM Customer Profile exists yet)
 *   - the profile exists but has no payment profiles attached
 *   - the CIM call fails (fails open — buyer sees an empty list,
 *     logs warn; better than a broken page on a transient Authorize.net
 *     hiccup)
 *
 * Auth: customer bearer (req.auth_context.actor_id populated by
 * Medusa's /store auth middleware).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  const cimProfileId = (customer.metadata as Record<string, any> | null)?.kaja_cim_profile_id as string | undefined
  if (!cimProfileId) {
    /* No CIM profile yet → buyer has no saved cards. Slice B will
     * lazy-create the profile when the buyer adds their first card. */
    return res.json({ ok: true, cards: [] as SavedCard[] })
  }

  const result = await getCustomerProfile(cimProfileId)
  if (result.ok !== true) {
    const errMsg = result.error
    logger.warn(`[payment-methods] getCustomerProfile failed for ${customerId} (cim=${cimProfileId}): ${errMsg}`)
    /* Fail open — return empty list rather than 500ing the account page.
     * Buyer can re-add cards via the next checkout if the CIM record
     * is somehow broken; admin can spot-check. */
    return res.json({ ok: true, cards: [] as SavedCard[] })
  }

  return res.json({ ok: true, cards: result.cards })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { deleteCustomerPaymentProfile } from "../../../../../../../lib/kaja-authnet"

/**
 * DELETE /store/mbs/customers/me/payment-methods/:id
 *
 * Removes a single saved card (CIM Payment Profile) from the buyer's
 * Authorize.net Customer Profile. The CIM Customer Profile itself
 * stays — cheap to keep around for the next card add, and avoids
 * re-creating from scratch on subsequent saves.
 *
 * Path param `id` = customerPaymentProfileId (the saved-card's id
 * from Authorize.net). Caller already has it because GET ../ returns
 * cards with these ids.
 *
 * Auth: customer bearer. Implicitly scoped to the signed-in customer's
 * own CIM profile — we never accept a customerProfileId from the
 * client; it's looked up from customer.metadata.kaja_cim_profile_id.
 * Means a buyer can't ask to delete someone else's card by guessing
 * a payment profile id.
 */
export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  const paymentProfileId = req.params.id
  if (!paymentProfileId) {
    return res.status(400).json({ ok: false, message: "Missing payment-method id" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }
  const cimProfileId = (customer.metadata as Record<string, any> | null)?.kaja_cim_profile_id as string | undefined
  if (!cimProfileId) {
    /* No CIM profile means no cards to delete — treat as already gone. */
    return res.status(404).json({ ok: false, message: "No saved cards on file" })
  }

  const result = await deleteCustomerPaymentProfile({
    customerProfileId: cimProfileId,
    customerPaymentProfileId: paymentProfileId,
  })
  if (!result.ok) {
    logger.warn(`[payment-methods] delete failed for customer=${customerId} paymentProfile=${paymentProfileId}: ${result.error}`)
    return res.status(500).json({ ok: false, message: result.error ?? "Could not remove saved card" })
  }

  /* Stamp metadata.payment_methods_updated_at so admin can see when
   * a buyer touched their saved cards. Non-fatal. */
  try {
    const meta = (customer.metadata as Record<string, any> | null) ?? {}
    await customerService.updateCustomers(customerId, {
      metadata: { ...meta, payment_methods_updated_at: new Date().toISOString() },
    })
  } catch { /* non-fatal */ }

  logger.info(`[payment-methods] removed saved card ${paymentProfileId} for customer ${customerId}`)
  return res.json({ ok: true, id: paymentProfileId })
}

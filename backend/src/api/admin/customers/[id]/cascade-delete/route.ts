import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { deleteCustomersWorkflow } from "@medusajs/medusa/core-flows"

/**
 * POST /admin/customers/:id/cascade-delete
 *
 * Deletes a customer + their auth_identity + provider_identity rows
 * in one shot, leaving the email truly free to re-register.
 *
 * Medusa's standard delete-customer button only removes the Customer
 * row — auth_identity/provider_identity rows for emailpass remain
 * orphaned. That blocks the email from re-registering ("ALREADY_
 * APPROVED" on the apply form). This route does both.
 *
 * Wired to a custom widget button on the customer detail page so the
 * operator never has to remember the delete-customer-fully script.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const authService: any = req.scope.resolve(Modules.AUTH)

  /* 1. Read the customer's email BEFORE deletion (we need it to find
   *    the auth identity, which keys off email via provider_identity). */
  let email: string | null = null
  try {
    const list = await customerService.listCustomers({ id: [customerId] }, { take: 1 })
    const c = list?.[0]
    if (c) email = (c.email ?? "").trim().toLowerCase()
  } catch (e: any) {
    logger.warn(`[cascade-delete] customer lookup failed: ${e?.message}`)
  }
  if (!email) {
    return res.status(404).json({ ok: false, message: "Customer not found." })
  }

  /* 2. Look up auth identities that match this email/emailpass. */
  let authIdentityIds: string[] = []
  try {
    const identities = await authService.listAuthIdentities({
      provider_identities: { entity_id: email, provider: "emailpass" },
    })
    authIdentityIds = identities.map((a: any) => a.id)
  } catch (e: any) {
    logger.warn(`[cascade-delete] auth identity lookup failed: ${e?.message}`)
  }

  /* 3. Delete the customer (cascades address + group memberships). */
  let customerDeleted = false
  try {
    await deleteCustomersWorkflow(req.scope).run({ input: { ids: [customerId] } })
    customerDeleted = true
    logger.info(`[cascade-delete] deleted customer ${customerId} (${email})`)
  } catch (e: any) {
    logger.error(`[cascade-delete] customer delete failed: ${e?.message ?? String(e)}`)
    return res.status(500).json({ ok: false, message: `Customer delete failed: ${e?.message ?? "unknown error"}` })
  }

  /* 4. Delete the auth identities (cascades provider_identity).
   *    Continue if this fails — the customer is already gone, partial
   *    cleanup is logged for ops to clean up via the script. */
  let authDeleted = 0
  if (authIdentityIds.length > 0) {
    try {
      await authService.deleteAuthIdentities(authIdentityIds)
      authDeleted = authIdentityIds.length
      logger.info(`[cascade-delete] deleted ${authDeleted} auth identity(ies) for ${email}`)
    } catch (e: any) {
      logger.error(`[cascade-delete] auth delete failed (customer already gone): ${e?.message}`)
    }
  }

  return res.json({
    ok: true,
    summary: {
      email,
      customerDeleted,
      authIdentitiesDeleted: authDeleted,
    },
  })
}

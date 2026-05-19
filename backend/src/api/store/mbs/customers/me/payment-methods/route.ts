import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createCustomerPaymentProfile,
  createCustomerProfile,
  getCustomerPaymentProfile,
  getCustomerProfile,
  type BillingAddress,
  type SavedCard,
} from "../../../../../../lib/kaja-authnet"

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
    /* No CIM profile yet → buyer has no saved cards. POST below lazy-
     * creates the profile when the buyer adds their first card. */
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

/**
 * POST /store/mbs/customers/me/payment-methods
 *
 * Saves a new card (CIM Payment Profile) for the signed-in buyer.
 * Body: { opaqueData: { dataDescriptor, dataValue } }
 *   - opaqueData is Accept.js's tokenized card payload. The storefront
 *     tokenizes via window.Accept.dispatchData() and posts the result
 *     here — raw PAN never reaches our server (PCI SAQ-A-EP).
 *
 * Lazy-creates the CIM Customer Profile on first card save and stamps
 * customer.metadata.kaja_cim_profile_id so subsequent saves + reads
 * resolve the right profile. billTo for the payment profile is pulled
 * from the customer's default billing address (set in /account) — falls
 * back to a minimal billTo (name only) if the buyer hasn't filled in
 * an address yet. Authorize.net's AVS-enabled accounts may reject the
 * latter, in which case the buyer needs to set their billing address
 * before saving cards.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  const body = (req.body ?? {}) as { opaqueData?: { dataDescriptor?: string; dataValue?: string } }
  const opaqueData = body.opaqueData
  if (!opaqueData?.dataDescriptor || !opaqueData?.dataValue) {
    return res.status(400).json({ ok: false, message: "Missing card token" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService.listCustomers(
    { id: [customerId] },
    { relations: ["addresses"], take: 1 },
  ).catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  const meta = (customer.metadata as Record<string, any> | null) ?? {}
  let cimProfileId = meta.kaja_cim_profile_id as string | undefined

  /* Lazy-create the CIM Customer Profile on first save. createCustomer
   * Profile surfaces an existing profile id when Authorize.net rejects
   * the merchantCustomerId for duplication (E00039) — we accept that
   * path too, so two parallel "first saves" race-safe to the same
   * profile id. */
  if (!cimProfileId) {
    const profileResult = await createCustomerProfile({
      medusaCustomerId: customerId,
      email: customer.email ?? "",
      description: `B2B buyer ${customer.email ?? customerId}`,
    })
    /* TS discriminated-union narrowing doesn't carry through `if (x.ok)`
     * cleanly when the failure branch has extra fields — pull each
     * variant's fields out via locals so the rest of the block reads
     * straight. See feedback_authnet_provider_quirks.md. */
    if (profileResult.ok === true) {
      cimProfileId = profileResult.customerProfileId
    } else {
      const errMsg = profileResult.error
      const existingId = profileResult.existingProfileId
      if (existingId) {
        logger.warn(`[payment-methods] createCustomerProfile duplicate for ${customerId}, using existing ${existingId}`)
        cimProfileId = existingId
      } else {
        logger.warn(`[payment-methods] createCustomerProfile failed for ${customerId}: ${errMsg}`)
        return res.status(500).json({ ok: false, message: errMsg ?? "Could not initialize saved-cards profile" })
      }
    }

    /* Persist the new profile id immediately so subsequent saves +
     * GETs see it (metadata writes merge in v2). */
    try {
      await customerService.updateCustomers(customerId, {
        metadata: { ...meta, kaja_cim_profile_id: cimProfileId },
      })
    } catch (e: any) {
      logger.warn(`[payment-methods] could not persist kaja_cim_profile_id for ${customerId}: ${e?.message ?? e}`)
      /* Not fatal — the saved card still works for this request, but
       * the next request won't find it. Surface a soft warning so
       * operator can spot-check. */
    }
  }

  /* Derive billTo from the buyer's default billing address. Mirrors
   * the same selection rule the storefront uses at checkout — default-
   * billing flag first, fall back to first address. */
  const addresses = Array.isArray(customer.addresses) ? customer.addresses : []
  const billingAddr =
    addresses.find((a: any) => a?.is_default_billing) ??
    addresses[0] ??
    null

  const billTo: BillingAddress = billingAddr
    ? {
        firstName: billingAddr.first_name ?? customer.first_name ?? null,
        lastName: billingAddr.last_name ?? customer.last_name ?? null,
        company: billingAddr.company ?? null,
        address: billingAddr.address_1 ?? null,
        city: billingAddr.city ?? null,
        state: billingAddr.province ?? null,
        zip: billingAddr.postal_code ?? null,
        country: (billingAddr.country_code ?? "US").toUpperCase() === "US" ? "USA" : billingAddr.country_code ?? null,
        phone: billingAddr.phone ?? customer.phone ?? null,
      }
    : {
        firstName: customer.first_name ?? null,
        lastName: customer.last_name ?? null,
      }

  const createResult = await createCustomerPaymentProfile({
    customerProfileId: cimProfileId!,
    opaqueData: { dataDescriptor: opaqueData.dataDescriptor, dataValue: opaqueData.dataValue },
    billTo,
  })
  if (createResult.ok !== true) {
    const errMsg = createResult.error
    const errCode = createResult.code
    logger.warn(`[payment-methods] createCustomerPaymentProfile failed for ${customerId} (cim=${cimProfileId}): ${errMsg}`)
    return res.status(400).json({ ok: false, message: errMsg ?? "Could not save card", code: errCode })
  }
  const newPaymentProfileId = createResult.customerPaymentProfileId

  /* Fetch the new payment profile so we can return the SavedCard shape
   * (cardType + last4) for optimistic UI on the storefront. Failure
   * here is non-fatal — the card IS saved; we just can't surface its
   * metadata. Storefront will re-fetch via GET on next mount. */
  const fetched = await getCustomerPaymentProfile({
    customerProfileId: cimProfileId!,
    customerPaymentProfileId: newPaymentProfileId,
  })

  /* Stamp metadata.payment_methods_updated_at so admin can see when
   * a buyer touched their saved cards. Non-fatal. */
  try {
    const latestMeta = (customer.metadata as Record<string, any> | null) ?? {}
    await customerService.updateCustomers(customerId, {
      metadata: {
        ...latestMeta,
        kaja_cim_profile_id: cimProfileId,
        payment_methods_updated_at: new Date().toISOString(),
      },
    })
  } catch { /* non-fatal */ }

  logger.info(`[payment-methods] saved card ${newPaymentProfileId} for customer ${customerId}`)

  if (fetched.ok === true) {
    return res.status(201).json({ ok: true, card: fetched.card })
  }
  /* Minimal fallback when the post-create fetch failed — storefront
   * will refresh from GET on next mount. */
  return res.status(201).json({
    ok: true,
    card: {
      id: newPaymentProfileId,
      cardType: "Card",
      last4: "",
      expirationDate: null,
    } as SavedCard,
  })
}

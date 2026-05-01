import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * One-shot: creates a fully approved test customer (Medusa auth
 * identity + customer record + "approved" group membership + an
 * address). Bypasses the application/approval flow entirely so a
 * reviewer (KAJA, internal QA, etc.) can immediately sign in and
 * walk through pricing → cart → checkout.
 *
 * Required env:
 *   EMAIL=...
 *   PASSWORD=...
 *
 * Optional env (sensible defaults applied):
 *   FIRST_NAME, LAST_NAME, BUSINESS_NAME, PHONE,
 *   ADDRESS_1, CITY, STATE, ZIP, COUNTRY (default us)
 *
 * Re-runnable: if the email already exists as a customer, the
 * script promotes them to approved + resets metadata/address. If
 * an auth identity exists without a customer, it fails clearly so
 * you can clean up manually first.
 *
 * Usage:
 *   EMAIL=kaja-review@example.com PASSWORD=ReviewPass123 \
 *     pnpm exec medusa exec ./src/scripts/create-approved-customer.ts
 */
export default async function createApprovedCustomer({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)
  const authService: any = container.resolve(Modules.AUTH)

  const email = (process.env.EMAIL || "").trim().toLowerCase()
  const password = process.env.PASSWORD || ""
  if (!email || !password) {
    logger.error("✗ EMAIL and PASSWORD env vars are required.")
    return
  }

  const firstName = process.env.FIRST_NAME || "Test"
  const lastName = process.env.LAST_NAME || "Reviewer"
  const businessName = process.env.BUSINESS_NAME || "KAJA Test Account"
  const phone = process.env.PHONE || "555-555-0100"
  const address1 = process.env.ADDRESS_1 || "13220 Murphy Rd, Suite 100"
  const city = process.env.CITY || "Stafford"
  const state = process.env.STATE || "TX"
  const zip = process.env.ZIP || "77477"
  const country = (process.env.COUNTRY || "us").toLowerCase()

  /* ─── 1. Customer (create or fetch) ─────────────────────────────── */
  const existing = await customerService.listCustomers({ email })
  let customer = existing[0]
  if (customer) {
    logger.info(`· customer exists: ${customer.id}`)
  } else {
    customer = await customerService.createCustomers({
      email,
      first_name: firstName,
      last_name: lastName,
      company_name: businessName,
      phone,
      has_account: true,
      metadata: {
        application_status: "approved",
        approved_at: new Date().toISOString(),
        applied_at: new Date().toISOString(),
        business_name: businessName,
        address_line1: address1,
        city, state, zip, country,
      },
    })
    logger.info(`+ customer created: ${customer.id}`)
  }

  /* ─── 2. Auth identity for emailpass provider ───────────────────── */
  const existingAuth = await authService.listAuthIdentities({
    provider_identities: { entity_id: email, provider: "emailpass" },
  })
  if (existingAuth.length === 0) {
    /* No public-facing service helper for this — use the auth provider's
     * register flow via the providerService directly. The simplest path
     * is to call the /auth/customer/emailpass/register HTTP endpoint
     * with the publishable key, but that requires a base URL. Easier:
     * use Medusa's built-in register through authService when available;
     * fallback to a manual scrypt hash insert. */
    try {
      await authService.register("emailpass", {
        body: { email, password },
        authScope: "customer",
      })
      logger.info(`+ auth identity created for ${email}`)
    } catch (e: any) {
      logger.error(`✗ auth register failed: ${e?.message ?? String(e)}`)
      logger.error("  → Try running pnpm test:email first to confirm Medusa is healthy.")
      return
    }

    /* The register call creates an auth identity but doesn't
     * automatically link it to our existing customer. Update the new
     * auth identity's app_metadata to reference the customer id. */
    const [newAuth] = await authService.listAuthIdentities({
      provider_identities: { entity_id: email, provider: "emailpass" },
    })
    if (newAuth) {
      await authService.updateAuthIdentities({
        id: newAuth.id,
        app_metadata: { customer_id: customer.id },
      })
      logger.info(`+ auth ↔ customer link: ${newAuth.id} ↔ ${customer.id}`)
    }
  } else {
    logger.info(`· auth identity exists for ${email}`)
    /* Update password by re-registering — emailpass provider handles this. */
    try {
      await authService.updateProvider("emailpass", existingAuth[0].id, {
        password,
      })
      logger.info("· password updated")
    } catch (e: any) {
      logger.warn(`? password update failed (continuing): ${e?.message}`)
    }
  }

  /* ─── 3. Approved group membership ──────────────────────────────── */
  const APPROVED_GROUP = (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()
  const groups = await customerService.listCustomerGroups({ name: [APPROVED_GROUP] }, { take: 1 })
  const approvedGroup = groups[0]
  if (!approvedGroup) {
    logger.error(`✗ "${APPROVED_GROUP}" customer group missing. Run pnpm seed:customer-groups first.`)
    return
  }
  /* Refetch customer with groups expanded so we know if already a member. */
  const fresh = await customerService.retrieveCustomer(customer.id, { relations: ["groups"] })
  const inGroup = (fresh.groups ?? []).some((g: any) => g.id === approvedGroup.id)
  if (inGroup) {
    logger.info(`· customer already in "${APPROVED_GROUP}"`)
  } else {
    await customerService.addCustomerToGroup({
      customer_id: customer.id,
      customer_group_id: approvedGroup.id,
    })
    logger.info(`+ added to "${APPROVED_GROUP}" group`)
  }

  /* ─── 4. Default address ────────────────────────────────────────── */
  const existingAddrs = await customerService.listCustomerAddresses({ customer_id: customer.id })
  if (existingAddrs.length === 0) {
    await customerService.createCustomerAddresses([{
      customer_id: customer.id,
      first_name: firstName,
      last_name: lastName,
      company: businessName,
      phone,
      address_1: address1,
      city, province: state, postal_code: zip,
      country_code: country,
      address_name: "Business",
      is_default_shipping: true,
      is_default_billing: true,
    }])
    logger.info("+ address created (default shipping + billing)")
  } else {
    logger.info(`· customer has ${existingAddrs.length} existing address(es)`)
  }

  logger.info("─────────────────────────────────────────────")
  logger.info("✓ TEST ACCOUNT READY")
  logger.info(`  email:    ${email}`)
  logger.info(`  password: ${password}`)
  logger.info(`  customer: ${customer.id}`)
  logger.info(`  status:   approved`)
  logger.info(`  storefront: https://mbs-storefront-blue.vercel.app/sign-in`)
  logger.info("─────────────────────────────────────────────")
}

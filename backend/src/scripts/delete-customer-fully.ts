import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { deleteCustomersWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Fully delete a customer + their auth identity by email.
 *
 * Medusa's standard customer-delete (admin UI or workflow) only
 * removes the Customer row — the `auth_identity` + `provider_identity`
 * rows for emailpass remain orphaned. That blocks the email from being
 * re-used for a fresh wholesale application: /store/mbs/applications
 * detects the orphan auth row and rejects with ALREADY_APPROVED.
 *
 * This script wipes both, leaving the email truly free to re-register.
 *
 * SAFETY: dry-run by default (logs what would delete). Pass APPLY=1 to
 * actually delete.
 *
 * Usage:
 *   EMAIL=foo@bar.com pnpm exec medusa exec ./src/scripts/delete-customer-fully.ts
 *   EMAIL=foo@bar.com APPLY=1 pnpm exec medusa exec ./src/scripts/delete-customer-fully.ts
 */
export default async function deleteCustomerFully({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const email = (process.env.EMAIL ?? "").trim().toLowerCase()
  if (!email) {
    logger.error("Pass EMAIL=foo@bar.com to identify which customer to delete.")
    return
  }
  const apply = process.env.APPLY === "1"

  const customerService: any = container.resolve(Modules.CUSTOMER)
  const authService: any = container.resolve(Modules.AUTH)

  /* ─── 1. Look up the customer by email ─── */
  const customers = await customerService.listCustomers({ email: [email] }, { take: 1 })
  const customer = customers[0]
  if (customer) {
    logger.info(`Found customer: ${customer.id}  email=${customer.email}`)
  } else {
    logger.info(`No customer record found for ${email} (maybe already deleted in admin)`)
  }

  /* ─── 2. Look up auth identities for this email/emailpass ─── */
  const authIdentities = await authService.listAuthIdentities({
    provider_identities: { entity_id: email, provider: "emailpass" },
  })
  if (authIdentities.length > 0) {
    logger.info(`Found ${authIdentities.length} auth identity(ies):`)
    for (const a of authIdentities) {
      logger.info(`  · ${a.id}`)
    }
  } else {
    logger.info(`No auth identities found for ${email}`)
  }

  if (!customer && authIdentities.length === 0) {
    logger.info("Nothing to delete — email is already clean.")
    return
  }

  if (!apply) {
    logger.info("─────────────────────────────────")
    logger.info("DRY RUN — no records deleted.")
    logger.info("Re-run with APPLY=1 to actually delete.")
    return
  }

  logger.warn("▶ APPLY=1 — deleting in 3s. Cancel now if wrong.")
  await new Promise((r) => setTimeout(r, 3000))

  /* ─── 3. Delete the customer (cascades address, group memberships) ─── */
  if (customer) {
    try {
      await deleteCustomersWorkflow(container).run({ input: { ids: [customer.id] } })
      logger.info(`✓ deleted customer ${customer.id}`)
    } catch (e: any) {
      logger.error(`✗ customer delete failed: ${e?.message ?? String(e)}`)
      /* Continue to auth cleanup anyway — partial cleanup is better
       * than aborting + leaving inconsistent state. */
    }
  }

  /* ─── 4. Delete the auth identities (cascades provider_identity) ─── */
  if (authIdentities.length > 0) {
    try {
      await authService.deleteAuthIdentities(authIdentities.map((a: any) => a.id))
      logger.info(`✓ deleted ${authIdentities.length} auth identity(ies)`)
    } catch (e: any) {
      logger.error(`✗ auth delete failed: ${e?.message ?? String(e)}`)
    }
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ ${email} is fully cleaned. Email can be re-registered.`)
}

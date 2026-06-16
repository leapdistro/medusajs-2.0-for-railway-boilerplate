import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Idempotent: ensures the wholesale-related customer groups exist.
 *
 * Groups:
 *   - "approved" — wholesale-application flow gates buyers on this.
 *     `/admin/customers/[id]/approve-and-welcome` requires it (500 if
 *     missing); storefront `useIsApproved()` checks membership to gate
 *     pricing + checkout. Name overridable via `APPROVED_GROUP_NAME`.
 *   - "owner_stores" — operator's own retail outlets (separate legal
 *     entity). See pricing-modes slice — buyers in this group pay
 *     landed cost + an admin-set markup.
 *   - "distro" — distributor customers. See pricing-modes slice —
 *     buyers in this group pay distro-tier prices from settings.
 *   - "tier_2" / "tier_3" — additional wholesale price tables, set in
 *     MBS Settings → Flower/Pre-Roll Tier Prices alongside the default
 *     table. Mutually exclusive with each other and with distro /
 *     owner_stores.
 *
 * Run: pnpm seed:customer-groups
 */
export default async function seedCustomerGroups({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  const APPROVED_GROUP_NAME =
    (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

  const groups = [APPROVED_GROUP_NAME, "owner_stores", "distro", "tier_2", "tier_3"]

  for (const name of groups) {
    const existing = await customerService.listCustomerGroups(
      { name: [name] },
      { take: 1 },
    )
    if (existing.length > 0) {
      logger.info(`· "${name}" customer group already exists`)
      continue
    }
    await customerService.createCustomerGroups([{ name }])
    logger.info(`+ created "${name}" customer group`)
  }
}

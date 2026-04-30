import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Idempotent: ensures the "approved" customer group exists.
 *
 * The wholesale-application flow gates buyers based on whether they're
 * in this group:
 *   - `/admin/customers/[id]/approve-and-welcome` requires it (returns
 *     500 if missing)
 *   - storefront `useIsApproved()` checks group membership to gate
 *     pricing + checkout
 *
 * Custom group name can be overridden via `APPROVED_GROUP_NAME` env
 * var on the backend (defaults to "approved"). This script reads the
 * same env var so seed and runtime stay in sync.
 *
 * Run: pnpm seed:customer-groups
 */
export default async function seedCustomerGroups({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  const APPROVED_GROUP_NAME =
    (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

  const existing = await customerService.listCustomerGroups(
    { name: [APPROVED_GROUP_NAME] },
    { take: 1 },
  )
  if (existing.length > 0) {
    logger.info(`· "${APPROVED_GROUP_NAME}" customer group already exists`)
    return
  }

  await customerService.createCustomerGroups([{ name: APPROVED_GROUP_NAME }])
  logger.info(`+ created "${APPROVED_GROUP_NAME}" customer group`)
}

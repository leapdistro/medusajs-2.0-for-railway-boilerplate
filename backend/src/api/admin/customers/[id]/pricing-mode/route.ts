import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/customers/:id/pricing-mode { mode: "owner_stores" | "distro" | null }
 *
 * Sets (or clears) `customer.metadata.pricing_mode` AND keeps customer
 * group membership in sync. The metadata is what the admin widget
 * reads; the customer group is what Medusa price lists (slice 4) key
 * off for pricing at cart resolution time.
 *
 * "owner_stores" → buyer pays landed cost + admin markup
 * "distro"       → buyer pays operator-set distro tier prices
 * null/absent    → buyer pays default tier prices (everyone else)
 *
 * The two pricing groups are mutually exclusive — picking one removes
 * the customer from the other.
 */

const VALID_MODES = ["owner_stores", "distro"] as const
const PRICING_GROUP_NAMES = ["owner_stores", "distro"] as const

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const body = (req.body ?? {}) as { mode?: string | null }
  const requestedRaw = body.mode == null ? null : String(body.mode).trim().toLowerCase()
  const requested =
    !requestedRaw || requestedRaw === "default" || requestedRaw === ""
      ? null
      : (VALID_MODES as readonly string[]).includes(requestedRaw)
        ? requestedRaw
        : "__INVALID__"
  if (requested === "__INVALID__") {
    return res.status(400).json({
      ok: false,
      message: `Invalid mode. Allowed: ${VALID_MODES.join(", ")} or null/default.`,
    })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const list = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => null)
  const customer = list?.[0]
  if (!customer) return res.status(404).json({ ok: false, message: "Customer not found" })

  /* Resolve our two pricing groups by name (seed creates them — see
   * seed-customer-groups.ts). Tolerate either missing in case the seed
   * hasn't run yet on this env. */
  const groups = await customerService.listCustomerGroups(
    { name: [...PRICING_GROUP_NAMES] },
    { take: 10 },
  )
  const groupByName: Record<string, string> = {}
  for (const g of groups) groupByName[g.name] = g.id

  /* Sync group membership — remove from both pricing groups, then add
   * to the requested one (if any). Safe to call remove for groups the
   * customer isn't in; Medusa no-ops. Single-object form per the
   * `approve-and-welcome` pattern elsewhere in this codebase. */
  try {
    for (const name of PRICING_GROUP_NAMES) {
      if (!groupByName[name]) continue
      await customerService.removeCustomerFromGroup({
        customer_id: customer.id,
        customer_group_id: groupByName[name],
      }).catch(() => { /* already removed — fine */ })
    }
    if (requested && groupByName[requested]) {
      await customerService.addCustomerToGroup({
        customer_id: customer.id,
        customer_group_id: groupByName[requested],
      })
    }
  } catch (e: any) {
    logger.error(`[pricing-mode] group sync failed for ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Group sync failed" })
  }

  /* Mirror the payment-terms pattern: explicit `null` (not delete) so
   * Medusa v2's metadata-merge stores the null and downstream reads
   * see it. Delete-then-merge leaves the old key in the DB. */
  const nextMeta = { ...(customer.metadata ?? {}) } as Record<string, any>
  nextMeta.pricing_mode = requested

  try {
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })
  } catch (e: any) {
    logger.error(`[pricing-mode] update failed for ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Update failed" })
  }

  logger.info(`[pricing-mode] ${customer.email} → ${requested ?? "default"}`)
  return res.json({ ok: true, pricingMode: requested })
}

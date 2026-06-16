import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/customers/:id/pricing-mode
 *   { mode: "owner_stores" | "distro" | "tier_2" | "tier_3" | null }
 *
 * Sets (or clears) `customer.metadata.pricing_mode` AND keeps customer
 * group membership in sync. The metadata is what the admin widget
 * reads; the customer group is what Medusa price lists key off for
 * pricing at cart resolution time.
 *
 * "owner_stores"   → landed cost + admin markup
 * "distro"         → operator-set distro tier prices
 * "tier_2"/"tier_3"→ operator-set tier_2/tier_3 prices (from Flower /
 *                    Pre-Roll Tier Prices tabs)
 * null/absent      → buyer pays default tier prices (everyone else)
 *
 * All pricing groups are mutually exclusive — picking one removes the
 * customer from the other three.
 */

const VALID_MODES = ["owner_stores", "distro", "tier_2", "tier_3"] as const
const PRICING_GROUP_NAMES = ["owner_stores", "distro", "tier_2", "tier_3"] as const

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

  /* Fail loudly BEFORE we touch any membership if the requested target
   * group doesn't exist. Old behavior silently skipped the add and left
   * the customer with metadata.pricing_mode = "tier_X" but no group
   * membership — storefront then fell through to default prices and the
   * operator had no signal anything was wrong. Surface a clear seed
   * instruction instead. */
  if (requested && !groupByName[requested]) {
    return res.status(400).json({
      ok: false,
      message: `\`${requested}\` customer group missing. Run \`pnpm seed:customer-groups\` on the backend, then retry.`,
    })
  }

  /* Sync group membership — remove from all pricing groups, then add
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
    if (requested) {
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

  /* Belt-and-suspenders mutex check — re-read the customer's groups and
   * fail loudly if more than one pricing group is present. Catches:
   * (a) operator directly editing customer.groups via Medusa's native
   * UI, (b) a race against a concurrent pricing-mode write, (c) any
   * future code path that touches group membership and forgets the
   * mutex. Storefront PriceList resolution would otherwise pick one of
   * the two non-deterministically. */
  try {
    const [post] = await customerService.listCustomers(
      { id: [customer.id] },
      { take: 1, relations: ["groups"] },
    )
    const activePricingGroups = ((post?.groups ?? []) as Array<{ id?: string; name?: string }>)
      .map((g) => g?.name)
      .filter((n): n is string => Boolean(n) && (PRICING_GROUP_NAMES as readonly string[]).includes(n))
    if (activePricingGroups.length > 1) {
      logger.error(
        `[pricing-mode] mutex violation for ${customer.email}: in ${activePricingGroups.length} pricing groups (${activePricingGroups.join(", ")}) after write to "${requested ?? "default"}"`,
      )
      return res.status(500).json({
        ok: false,
        message: `Pricing mode mutex violation — customer is in ${activePricingGroups.length} pricing groups (${activePricingGroups.join(", ")}). Manual cleanup required in Medusa admin.`,
      })
    }
  } catch (e: any) {
    /* Don't fail the whole request on a verification read error — the
     * write itself succeeded. Log so we notice if this happens often. */
    logger.warn(`[pricing-mode] post-write mutex check failed for ${customer.email}: ${e?.message}`)
  }

  logger.info(`[pricing-mode] ${customer.email} → ${requested ?? "default"}`)
  return res.json({ ok: true, pricingMode: requested })
}

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Diagnostic: pricing-mode end-to-end state for one customer.
 *
 * Walks the four conditions that have to be true for a tier_2 / tier_3
 * / distro buyer to see their group price on the storefront:
 *
 *   1. The customer group exists in Medusa.
 *   2. The customer is a member of exactly one pricing group.
 *   3. A PriceList scoped to that group exists and is active.
 *   4. That PriceList has prices written for variants in the catalog.
 *
 * Prints PASS/FAIL per check. First FAIL is your bug.
 *
 * Run: pnpm exec medusa exec ./src/scripts/inspect-pricing-mode.ts <email>
 *   or: pnpm inspect:pricing-mode <email>  (after adding the script alias)
 */
export default async function inspectPricingMode({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)
  const pricingService: any = container.resolve(Modules.PRICING)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const email = args[0]
  if (!email) {
    logger.error("Usage: pnpm exec medusa exec ./src/scripts/inspect-pricing-mode.ts <email>")
    process.exit(1)
  }

  logger.info(`▶ Inspecting pricing-mode state for ${email}`)
  logger.info("─────────────────────────────────")

  /* 0 — customer exists */
  const [customer] = await customerService.listCustomers(
    { email: [email] },
    { take: 1, relations: ["groups"] },
  )
  if (!customer) {
    logger.error(`✘ No customer with email ${email}`)
    return
  }
  logger.info(`✓ Customer ${customer.id} (${email})`)
  logger.info(`  metadata.pricing_mode = ${JSON.stringify(customer.metadata?.pricing_mode ?? null)}`)

  /* 1 — pricing groups exist */
  const PRICING_GROUPS = ["owner_stores", "distro", "tier_2", "tier_3"]
  const groups = await customerService.listCustomerGroups({ name: PRICING_GROUPS }, { take: 10 })
  const byName: Record<string, string> = {}
  for (const g of groups) byName[g.name] = g.id
  for (const name of PRICING_GROUPS) {
    if (byName[name]) logger.info(`  ✓ group "${name}" exists (${byName[name]})`)
    else logger.warn(`  ✘ group "${name}" MISSING — run pnpm seed:customer-groups`)
  }

  /* 2 — customer's actual group memberships */
  const memberships = ((customer.groups ?? []) as Array<{ id: string; name: string }>)
    .filter((g) => PRICING_GROUPS.includes(g.name))
  if (memberships.length === 0) {
    logger.warn(`  ✘ customer is NOT in any pricing group — storefront will see DEFAULT prices`)
  } else if (memberships.length === 1) {
    logger.info(`  ✓ customer is in group "${memberships[0].name}" (single — correct)`)
  } else {
    logger.error(`  ✘ MUTEX VIOLATION — customer is in ${memberships.length} pricing groups: ${memberships.map((m) => m.name).join(", ")}`)
  }

  /* 3 — does a PriceList exist for the relevant group? */
  const expectedTitle: Record<string, string> = {
    distro: "Distro Pricing",
    tier_2: "Tier 2 Pricing",
    tier_3: "Tier 3 Pricing",
    owner_stores: "Owner Stores Pricing",
  }
  const focusGroup = memberships[0]?.name ?? (customer.metadata?.pricing_mode as string | undefined)
  if (!focusGroup) {
    logger.info("─────────────────────────────────")
    logger.info("Customer has no pricing mode. They see default prices — expected.")
    return
  }

  const title = expectedTitle[focusGroup]
  if (!title) {
    logger.warn(`  ? no expected PriceList title mapped for "${focusGroup}"`)
    return
  }
  const lists = await pricingService.listPriceLists({ title: [title] }, { take: 1 }).catch(() => [])
  const pl = lists?.[0]
  if (!pl?.id) {
    logger.error(`  ✘ PriceList "${title}" DOES NOT EXIST — click Save & Apply All on the matching settings tab to create it`)
    return
  }
  logger.info(`  ✓ PriceList "${title}" exists (${pl.id}, status=${pl.status})`)

  /* 4 — does the PriceList have prices, and how many? */
  const { data: expanded } = await query.graph({
    entity: "price_list",
    fields: ["id", "status", "rules_count", "prices.id", "prices.amount", "prices.price_set_id"],
    filters: { id: pl.id },
  })
  const prices = ((expanded?.[0] as any)?.prices ?? []) as Array<{ id: string; amount: any; price_set_id: string }>
  logger.info(`  · PriceList has ${prices.length} prices, rules_count=${(expanded?.[0] as any)?.rules_count ?? "?"}`)
  if (prices.length === 0) {
    logger.error(`  ✘ PriceList "${title}" is EMPTY — Save & Apply must not have propagated. Click Save & Apply All again and watch the toast for the propagated count.`)
    return
  }

  /* 5 — does the PriceList rule actually target our group? */
  const { data: listsWithRules } = await query.graph({
    entity: "price_list",
    fields: ["id", "rules.*"],
    filters: { id: pl.id },
  })
  const rules = ((listsWithRules?.[0] as any)?.rules ?? []) as Array<{ attribute?: string; value?: any }>
  const groupId = byName[focusGroup]
  const ruleHit = rules.find((r) => r.attribute === "customer.groups.id" && JSON.stringify(r.value)?.includes(groupId))
  if (!ruleHit) {
    logger.error(`  ✘ PriceList "${title}" rule does NOT target "${focusGroup}" group id ${groupId}. Rules: ${JSON.stringify(rules)}`)
    return
  }
  logger.info(`  ✓ PriceList rule targets ${focusGroup} group ${groupId}`)

  logger.info("─────────────────────────────────")
  logger.info(`✓ Pricing-mode state for ${email} looks correct.`)
  logger.info(`  Expected: storefront PDP shows ${focusGroup} prices for ${prices.length} variants.`)
  logger.info(`  If it doesn't, check storefront /store/mbs/products auth_context (customer Bearer token must reach the route).`)
}

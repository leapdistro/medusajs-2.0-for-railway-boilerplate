import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * Find — look up customers by first/last name OR by email (substring).
 * Prints each match with the fields relevant to QBO push (id, email,
 * phone, business_name, qbo_customer_id) so we can see when one
 * person owns multiple Medusa accounts.
 *
 * Usage:
 *   DIAG_FIRST='Naeem' DIAG_LAST='Maredia' pnpm find:customers
 *   DIAG_EMAIL='maredia' pnpm find:customers
 */

const FIRST = process.env.DIAG_FIRST?.trim() || ""
const LAST = process.env.DIAG_LAST?.trim() || ""
const EMAIL = process.env.DIAG_EMAIL?.trim() || ""

export default async function findCustomers({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  if (!FIRST && !LAST && !EMAIL) {
    logger.error("❌ Provide at least one of DIAG_FIRST, DIAG_LAST, DIAG_EMAIL")
    return
  }
  logger.info(`═══ FIND CUSTOMERS — first="${FIRST}" last="${LAST}" email~"${EMAIL}" ═══`)

  /* listCustomers does substring on $ilike when we pass it. */
  const filter: any = {}
  if (FIRST) filter.first_name = { $ilike: `%${FIRST}%` }
  if (LAST) filter.last_name = { $ilike: `%${LAST}%` }
  if (EMAIL) filter.email = { $ilike: `%${EMAIL}%` }

  const matches = await customerService
    .listCustomers(filter, { take: 50 })
    .catch((e: any) => { logger.error(`listCustomers failed: ${e?.message}`); return [] })

  if (matches.length === 0) {
    logger.warn("No matches.")
    return
  }
  logger.info(`Found ${matches.length} match(es):`)
  for (const c of matches) {
    const m = (c.metadata ?? {}) as Record<string, any>
    logger.info("")
    logger.info(`  id:                 ${c.id}`)
    logger.info(`  first/last:         ${c.first_name} / ${c.last_name}`)
    logger.info(`  email:              ${c.email}`)
    logger.info(`  phone:              ${c.phone}`)
    logger.info(`  business_name:      ${m.business_name ?? "—"}`)
    logger.info(`  qbo_customer_id:    ${m.qbo_customer_id ?? "—"}`)
    logger.info(`  payment_terms:      ${m.payment_terms ?? "—"}`)
    logger.info(`  pricing_mode:       ${m.pricing_mode ?? "—"}`)
    logger.info(`  created_at:         ${c.created_at}`)
  }
  logger.info("")
  logger.info("═══ END ═══")
}

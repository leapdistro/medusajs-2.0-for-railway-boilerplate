import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Inspect a single cart (or recent carts) and dump billing + shipping
 * address IDs side by side. The point: confirm whether Medusa is pointing
 * `billing_address_id` and `shipping_address_id` at the SAME Address row.
 *
 * Symptom: storefront sends two distinct addresses, Medusa stores one
 * shared Address record, then any subsequent shipping update visibly
 * mutates the billing display because they're literally the same row.
 *
 * Usage (Railway shell):
 *   pnpm exec medusa exec ./src/scripts/inspect-cart.ts -- <cart_id>
 *   pnpm exec medusa exec ./src/scripts/inspect-cart.ts -- recent
 *
 * Without args, prints the 5 most recent carts' addresses + IDs.
 */
export default async function inspectCart({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)

  const cartId = args?.[0] && args[0] !== "recent" ? args[0] : null

  const ADDRESS_FIELDS = [
    "id",
    "first_name",
    "last_name",
    "company",
    "address_1",
    "address_2",
    "city",
    "province",
    "postal_code",
    "country_code",
    "phone",
  ]

  const CART_FIELDS = [
    "id",
    "email",
    "customer_id",
    "created_at",
    "updated_at",
    "billing_address_id",
    "shipping_address_id",
    ...ADDRESS_FIELDS.map((f) => `billing_address.${f}`),
    ...ADDRESS_FIELDS.map((f) => `shipping_address.${f}`),
  ]

  let carts: any[]
  if (cartId) {
    const { data } = await query.graph({
      entity: "cart",
      fields: CART_FIELDS,
      filters: { id: cartId },
    })
    carts = data
  } else {
    const { data } = await query.graph({
      entity: "cart",
      fields: CART_FIELDS,
      pagination: { take: 5, order: { created_at: "DESC" } },
    } as any)
    carts = data
  }

  if (!carts?.length) {
    logger.warn(cartId ? `No cart found with id ${cartId}` : "No carts found")
    return
  }

  for (const c of carts) {
    const ba = c.billing_address
    const sa = c.shipping_address
    const sameId = !!(ba?.id && sa?.id && ba.id === sa.id)

    logger.info("════════════════════════════════════════════════════════")
    logger.info(`cart.id              = ${c.id}`)
    logger.info(`email                = ${c.email}`)
    logger.info(`customer_id          = ${c.customer_id}`)
    logger.info(`updated_at           = ${c.updated_at}`)
    logger.info(`billing_address_id   = ${c.billing_address_id ?? "(null)"}`)
    logger.info(`shipping_address_id  = ${c.shipping_address_id ?? "(null)"}`)
    logger.info(sameId
      ? "⚠️  SAME ADDRESS ROW — billing_address_id === shipping_address_id"
      : "✓  distinct address rows (or one is null)")

    const dump = (label: string, a: any) => {
      if (!a) { logger.info(`${label}: (none)`); return }
      logger.info(`${label}:`)
      for (const f of ADDRESS_FIELDS) {
        logger.info(`  ${f.padEnd(14)} = ${a[f] ?? ""}`)
      }
    }
    dump("BILLING ", ba)
    dump("SHIPPING", sa)
  }

  logger.info("════════════════════════════════════════════════════════")
  logger.info(
    "If billing_address_id === shipping_address_id, the storefront's " +
    "auto-save (\"same as billing\") tripped Medusa into reusing the row. " +
    "Fix: send distinct payloads even when sameAsBilling is true, or " +
    "explicitly null the shipping_address before re-writing it."
  )
}

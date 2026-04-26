import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * One-off — fixes the shipping option price unit drift.
 *
 * Bug: original seed-us.ts wrote amounts as cents (1500, 3500, 6500)
 * assuming Medusa would interpret as $15 / $35 / $65. Medusa v2
 * actually stores amounts as whole currency units (same as variant
 * prices), so the storefront was displaying $1,500 / $3,500 / $6,500.
 *
 * Walks the four seeded options + sets the correct dollar amounts.
 * Idempotent — safe to re-run.
 *
 * Run via: pnpm seed:fix-shipping-prices
 */

const TARGET_PRICES_USD: Record<string, number> = {
  "Local Pickup":     0,
  "UPS Ground":       15,
  "UPS 2-Day Air":    35,
  "UPS Next Day Air": 65,
}

export default async function fixShippingPrices({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)
  const pricingService: any     = container.resolve(Modules.PRICING)

  logger.info("▶ Fixing shipping option prices…")

  /* Pull each option with its price_set so we know which money_amount
   * row to update via the pricing module. */
  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: [
      "id", "name",
      "price_set.id",
      "price_set.prices.id",
      "price_set.prices.amount",
      "price_set.prices.currency_code",
    ],
  })
  if (!options?.length) {
    logger.warn("✗ No shipping options found. Run `pnpm seed:us` first.")
    return
  }

  let updated = 0
  let skipped = 0
  for (const o of options as any[]) {
    const target = TARGET_PRICES_USD[o.name]
    if (target == null) {
      logger.info(`  · skipping ${o.name} (not in target list)`)
      skipped += 1
      continue
    }
    const usdPrice = (o.price_set?.prices ?? []).find(
      (p: any) => p?.currency_code?.toLowerCase() === "usd"
    )
    if (!usdPrice) {
      logger.warn(`  ! no USD price on ${o.name} — skipping`)
      skipped += 1
      continue
    }
    if (Number(usdPrice.amount) === target) {
      logger.info(`  · ${o.name} already correct ($${target})`)
      skipped += 1
      continue
    }
    try {
      await pricingService.updatePrices([{ id: usdPrice.id, amount: target }])
      logger.info(`  + ${o.name}: $${usdPrice.amount} → $${target}`)
      updated += 1
    } catch (e: any) {
      logger.warn(`  ! failed to update ${o.name}: ${e?.message}`)
    }
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ updated: ${updated}`)
  logger.info(`· skipped: ${skipped}`)
  logger.info("Done. Storefront cart should now show correct shipping prices.")
}

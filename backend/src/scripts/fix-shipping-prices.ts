import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * One-off — fixes shipping option price unit drift.
 *
 * Bug: original seed-us.ts wrote amounts as cents (1500, 3500, 6500)
 * assuming Medusa would interpret as $15 / $35 / $65. Medusa v2 actually
 * stores amounts as whole currency units (same as variant prices), so
 * the storefront was displaying $1,500 / $3,500 / $6,500.
 *
 * Uses updateShippingOptionsWorkflow (the canonical core flow) which
 * handles the Pricing-module link internally — we don't need to query
 * price_set ids directly. Idempotent: re-runs just rewrite the same
 * target values.
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
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)

  logger.info("▶ Fixing shipping option prices…")

  const options: Array<{ id: string; name: string }> =
    await fulfillmentService.listShippingOptions({})
  if (!options?.length) {
    logger.warn("✗ No shipping options found. Run `pnpm seed:us` first.")
    return
  }

  let updated = 0
  let skipped = 0
  for (const o of options) {
    const target = TARGET_PRICES_USD[o.name]
    if (target == null) {
      logger.info(`  · skipping ${o.name} (not in target list)`)
      skipped += 1
      continue
    }
    try {
      await updateShippingOptionsWorkflow(container).run({
        input: [{
          id: o.id,
          prices: [{ currency_code: "usd", amount: target }],
        }],
      })
      logger.info(`  + ${o.name}: ensured $${target}`)
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

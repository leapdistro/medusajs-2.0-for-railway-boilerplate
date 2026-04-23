import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_PRODUCTS } from "./data/mbs-products"

/**
 * One-off — corrects the price-unit mistake from the early `seed-mbs.ts`.
 *
 * Problem: original seed wrote prices as cents (e.g. 20000 for QP, expecting
 * Medusa to interpret as $200). Medusa actually stores prices in the
 * currency's whole units, so 20000 became $20,000.
 *
 * This script walks every variant of every MBS product, finds its USD
 * price, and overwrites with the correct dollar amount based on the same
 * map seed-mbs.ts now uses.
 *
 * Idempotent — safe to re-run. Run once with: pnpm seed:fix-prices
 * (then delete this file once the data is corrected.)
 */

const FLOWER_PRICES_USD: Record<string, number> = { qp: 200, half: 375, lb: 700 }
const PRE_ROLL_PRICE_USD = 200

const SIZE_TO_KEY: Record<string, string> = {
  "qp (1/4lb)":   "qp",
  "half (1/2lb)": "half",
  "full (1lb)":   "lb",
  "box of 30":    "box of 30",
  "box of 15":    "box of 15",
}

function priceFor(category: string, weightKey: string): number {
  if (category === "flower") return FLOWER_PRICES_USD[weightKey] ?? 0
  return PRE_ROLL_PRICE_USD
}

export default async function fixPrices({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingService: any = container.resolve(Modules.PRICING)

  logger.info("=== Fix prices starting ===")

  const slugSet = new Set(MBS_PRODUCTS.map((p) => p.slug))
  const slugToCategory = new Map(MBS_PRODUCTS.map((p) => [p.slug, p.category]))

  // Pull all our products with variants + price sets
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "handle",
      "variants.id",
      "variants.options.value", "variants.options.option.title",
      "variants.price_set.id",
      "variants.price_set.prices.id", "variants.price_set.prices.amount", "variants.price_set.prices.currency_code",
    ],
    filters: { handle: Array.from(slugSet) },
  })

  let updated = 0
  let skipped = 0

  for (const p of products as any[]) {
    const category = slugToCategory.get(p.handle)
    if (!category) continue
    for (const v of p.variants ?? []) {
      const sizeOpt = (v.options ?? []).find((o: any) => o.option?.title === "Size")
      const weightKey = sizeOpt ? (SIZE_TO_KEY[sizeOpt.value] ?? sizeOpt.value) : null
      if (!weightKey) {
        logger.warn(`  ! ${p.handle}: variant ${v.id} has no Size option`)
        continue
      }
      const wantPrice = priceFor(category, weightKey)
      const usdPrice = (v.price_set?.prices ?? []).find((pr: any) => pr.currency_code === "usd")
      if (!usdPrice) {
        logger.warn(`  ! ${p.handle}: variant ${v.id} has no USD price`)
        continue
      }
      if (Number(usdPrice.amount) === wantPrice) {
        skipped += 1
        continue
      }
      // Update via pricing module
      await pricingService.updatePrices([{
        id: usdPrice.id,
        amount: wantPrice,
      }])
      logger.info(`  ✓ ${p.handle} ${weightKey}: ${usdPrice.amount} → ${wantPrice}`)
      updated += 1
    }
  }

  logger.info(`=== Fix prices complete: ${updated} updated, ${skipped} already correct ===`)
}

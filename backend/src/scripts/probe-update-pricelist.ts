import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * Probe: does a single `updatePriceListPrices` call persist?
 *
 * Steps:
 *   1. Pick the first price on the Owner Stores PriceList.
 *   2. Read its current amount.
 *   3. Call updatePriceListPrices with our exact payload shape, amount + 0.01.
 *   4. Re-read.
 *   5. Compare. If amount didn't change, the update is silently failing
 *      and we need to find why.
 *
 * Also runs the same probe with DIFFERENT payload shapes side-by-side
 * (with/without min_quantity, with/without price_rules: [], etc.) so
 * we can identify exactly which field shape Medusa accepts.
 *
 * Read-only (the +$0.01 nudge is reverted at the end).
 */

const PRICE_LIST_TITLE = process.env.PROBE_LIST_TITLE || "Owner Stores Pricing"

export default async function probeUpdatePriceList({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingService: any = container.resolve(Modules.PRICING)

  logger.info(`═══ updatePriceListPrices PROBE — "${PRICE_LIST_TITLE}" ═══`)

  const lists = await pricingService.listPriceLists({ title: [PRICE_LIST_TITLE] }, { take: 1 })
  const pl = lists?.[0]
  if (!pl?.id) {
    logger.error(`❌ PriceList "${PRICE_LIST_TITLE}" not found`)
    return
  }
  logger.info(`PriceList id: ${pl.id}`)

  const { data: expanded } = await query.graph({
    entity: "price_list",
    fields: ["id", "prices.id", "prices.amount", "prices.price_set_id", "prices.currency_code"],
    filters: { id: pl.id },
  })
  const prices = (((expanded as any[])?.[0]?.prices ?? []) as any[]).slice(0, 1)
  if (prices.length === 0) {
    logger.error("❌ PriceList has no prices to probe")
    return
  }
  const target = prices[0]
  const amtNum = (a: any) => Number(a?.value ?? a?.numeric ?? a)
  const originalAmount = amtNum(target.amount)
  logger.info(`Target price id: ${target.id}`)
  logger.info(`  price_set_id:   ${target.price_set_id}`)
  logger.info(`  currency_code:  ${target.currency_code}`)
  logger.info(`  current amount: ${originalAmount}`)

  const probeAmount = Math.round((originalAmount + 0.13) * 100) / 100
  logger.info(`Probe amount (current + 0.13): ${probeAmount}`)
  logger.info("")

  const shapes: Array<{ label: string; payload: any }> = [
    {
      label: "minimal { id, amount }",
      payload: { id: target.id, amount: probeAmount },
    },
    {
      label: "with currency_code + price_set_id",
      payload: { id: target.id, price_set_id: target.price_set_id, currency_code: target.currency_code, amount: probeAmount + 0.01 },
    },
    {
      label: "with rules: {} (empty object)",
      payload: { id: target.id, price_set_id: target.price_set_id, currency_code: target.currency_code, amount: probeAmount + 0.02, rules: {} },
    },
    {
      label: "no id, only constraint match",
      payload: { price_set_id: target.price_set_id, currency_code: target.currency_code, amount: probeAmount + 0.03 },
    },
  ]

  for (const { label, payload } of shapes) {
    logger.info(`── shape: ${label} ──`)
    logger.info(`  payload: ${JSON.stringify(payload)}`)
    try {
      const result = await pricingService.updatePriceListPrices([{
        price_list_id: pl.id,
        prices: [payload],
      }])
      logger.info(`  call returned ${Array.isArray(result) ? result.length + " entity/entities" : typeof result}`)
    } catch (e: any) {
      logger.error(`  threw: ${e?.message}`)
    }

    /* Re-read amount for the target id. */
    const { data: re } = await query.graph({
      entity: "price",
      fields: ["id", "amount", "price_set_id"],
      filters: { id: target.id },
    })
    const rereadAmount = amtNum((re as any[])?.[0]?.amount)
    const wanted = payload.amount
    const matched = Math.abs(rereadAmount - wanted) < 0.005
    logger.info(`  re-read amount: ${rereadAmount}  → ${matched ? "✓ PERSISTED" : "❌ DID NOT PERSIST (still " + rereadAmount + ", expected " + wanted + ")"}`)
    logger.info("")
  }

  /* Revert to original so the probe doesn't leave junk data. */
  try {
    await pricingService.updatePriceListPrices([{
      price_list_id: pl.id,
      prices: [{ id: target.id, price_set_id: target.price_set_id, currency_code: target.currency_code, amount: originalAmount }],
    }])
    const { data: re } = await query.graph({ entity: "price", fields: ["amount"], filters: { id: target.id } })
    logger.info(`Reverted to original (${originalAmount}). Final amount: ${amtNum((re as any[])?.[0]?.amount)}`)
  } catch (e: any) {
    logger.warn(`Could not revert: ${e?.message}`)
  }

  logger.info("═══ END PROBE ═══")
}

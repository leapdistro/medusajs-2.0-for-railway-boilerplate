import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * Probe: batch-update — does updating N prices in one call persist all N?
 *
 * Takes the first N (default 20) prices on the Owner Stores PriceList,
 * applies a unique +0.01-per-row nudge, sends them as ONE batch payload,
 * then re-reads and reports how many actually persisted.
 *
 * If 0/20 persisted on a single call → batch updates are silently
 * dropping. If 20/20 → the bug is elsewhere. If some-but-not-all
 * → a per-row matching bug.
 *
 * Reverts to original amounts at the end.
 */

const PRICE_LIST_TITLE = process.env.PROBE_LIST_TITLE || "Owner Stores Pricing"
const PROBE_N = Number(process.env.PROBE_N || 20)

export default async function probeBatchUpdate({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingService: any = container.resolve(Modules.PRICING)

  logger.info(`═══ BATCH updatePriceListPrices PROBE — "${PRICE_LIST_TITLE}" · n=${PROBE_N} ═══`)

  const lists = await pricingService.listPriceLists({ title: [PRICE_LIST_TITLE] }, { take: 1 })
  const pl = lists?.[0]
  if (!pl?.id) {
    logger.error(`❌ PriceList not found`)
    return
  }

  const { data: expanded } = await query.graph({
    entity: "price_list",
    fields: ["id", "prices.id", "prices.amount", "prices.price_set_id", "prices.currency_code"],
    filters: { id: pl.id },
  })
  const allPrices = ((expanded as any[])?.[0]?.prices ?? []) as any[]
  const targets = allPrices.slice(0, PROBE_N)
  if (targets.length < PROBE_N) {
    logger.warn(`PriceList has only ${targets.length} prices; probing all of them`)
  }
  const amtNum = (a: any) => Number(a?.value ?? a?.numeric ?? a)
  const originals: Record<string, { price_set_id: string; currency_code: string; amount: number }> = {}
  for (const p of targets) {
    originals[p.id] = {
      price_set_id: p.price_set_id,
      currency_code: p.currency_code,
      amount: amtNum(p.amount),
    }
  }

  /* Build payload: each row gets a unique probe amount so we can
   * distinguish which writes persisted. */
  const probePrices = targets.map((p, idx) => ({
    id: p.id,
    price_set_id: p.price_set_id,
    currency_code: p.currency_code,
    amount: Math.round((amtNum(p.amount) + 0.01 * (idx + 1)) * 100) / 100,
  }))

  logger.info(`Sending ${probePrices.length} updates as ONE batch payload …`)
  try {
    const result = await pricingService.updatePriceListPrices([{
      price_list_id: pl.id,
      prices: probePrices,
    }])
    logger.info(`call returned ${Array.isArray(result) ? result.length + " entities" : typeof result}`)
  } catch (e: any) {
    logger.error(`batch threw: ${e?.message}`)
  }

  /* Re-read all targets in one query.graph. */
  const targetIds = targets.map((t) => t.id)
  const { data: re } = await query.graph({
    entity: "price",
    fields: ["id", "amount"],
    filters: { id: targetIds },
  })
  const freshById: Record<string, number> = {}
  for (const p of (re as any[]) ?? []) {
    freshById[String(p.id)] = amtNum(p.amount)
  }

  let persisted = 0
  let dropped = 0
  const droppedSample: string[] = []
  for (const p of probePrices) {
    const actual = freshById[p.id] ?? null
    if (actual != null && Math.abs(actual - p.amount) < 0.005) {
      persisted += 1
    } else {
      dropped += 1
      if (droppedSample.length < 3) {
        droppedSample.push(`${p.id} expected ${p.amount} actual ${actual ?? "null"}`)
      }
    }
  }

  logger.info(`Persisted: ${persisted}/${probePrices.length}`)
  logger.info(`Dropped:   ${dropped}/${probePrices.length}`)
  if (droppedSample.length > 0) {
    logger.info(`Dropped sample:`)
    for (const s of droppedSample) logger.info(`  - ${s}`)
  }

  /* Revert. */
  try {
    await pricingService.updatePriceListPrices([{
      price_list_id: pl.id,
      prices: targets.map((p) => ({
        id: p.id,
        price_set_id: originals[p.id].price_set_id,
        currency_code: originals[p.id].currency_code,
        amount: originals[p.id].amount,
      })),
    }])
    logger.info(`Reverted all ${targets.length} originals.`)
  } catch (e: any) {
    logger.warn(`Revert failed: ${e?.message}`)
  }

  logger.info("═══ END BATCH PROBE ═══")
}

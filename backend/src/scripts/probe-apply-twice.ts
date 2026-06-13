import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import { applyOwnerPrices } from "../lib/owner-prices-apply"

/**
 * Probe — run owner-prices apply twice in a row, sampling state between
 * each, to verify whether the FIRST call already persists or whether
 * the SECOND call is what makes the change stick.
 *
 * Steps:
 *   1. Read current markup from settings.
 *   2. Sample one price's current amount from the Owner Stores PriceList.
 *   3. Run applyOwnerPrices (first call). Log the summary.
 *   4. Sample the same price's amount.
 *   5. Run applyOwnerPrices (second call).
 *   6. Sample again.
 *
 * If sample after first call ≠ sample after second call → the "two
 * applies" bug is real and we can see exactly what state shifts
 * between the two calls.
 *
 * NOT idempotent — only run on a state you're OK leaving touched
 * (apply doesn't mutate anything that wasn't already valid).
 */

export default async function probeApplyTwice({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingService: any = container.resolve(Modules.PRICING)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)

  const scope: "flower" | "preroll" = (process.env.PROBE_SCOPE as any) || "flower"
  logger.info(`═══ APPLY-TWICE PROBE — scope=${scope} ═══`)

  const markupKey = scope === "flower" ? "flower_owner_markup_per_qp" : "preroll_owner_markup_per_box"
  const markup = Number(await settings.getSetting(markupKey))
  logger.info(`current ${markupKey}: $${markup}`)

  const lists = await pricingService.listPriceLists({ title: ["Owner Stores Pricing"] }, { take: 1 })
  const pl = lists?.[0]
  if (!pl?.id) {
    logger.error("❌ Owner Stores PriceList missing — run Apply once from admin first")
    return
  }

  const amtNum = (a: any) => Number(a?.value ?? a?.numeric ?? a)

  const samplePrice = async (label: string) => {
    const { data: re } = await query.graph({
      entity: "price_list",
      fields: ["id", "prices.id", "prices.amount", "prices.price_set_id"],
      filters: { id: pl.id },
    })
    const prices = ((re as any[])?.[0]?.prices ?? []) as any[]
    const first = prices[0]
    logger.info(`[sample @ ${label}] total prices=${prices.length} · first id=${first?.id} amount=${amtNum(first?.amount)}`)
    return { count: prices.length, firstAmount: first ? amtNum(first.amount) : null, firstId: first?.id }
  }

  logger.info("")
  logger.info("── BEFORE first apply ──")
  const before = await samplePrice("before")
  logger.info("")

  logger.info("── Calling applyOwnerPrices() — pass 1 ──")
  const pass1 = await applyOwnerPrices(container, scope)
  logger.info(`pass1 result: ok=${pass1.ok} added=${pass1.added} updated=${pass1.updated} skipped=${pass1.skipped}`)
  if ((pass1 as any).error) logger.error(`pass1 error: ${(pass1 as any).error}`)
  logger.info(`pass1 skip_reasons: ${JSON.stringify(pass1.skip_reasons ?? {})}`)
  logger.info("")

  logger.info("── AFTER pass 1 ──")
  const afterOne = await samplePrice("after-pass-1")
  const changed1 = before.firstAmount !== afterOne.firstAmount
  logger.info(`changed by pass 1: ${changed1 ? "✓ YES" : "❌ NO"} (${before.firstAmount} → ${afterOne.firstAmount})`)
  logger.info("")

  logger.info("── Calling applyOwnerPrices() — pass 2 ──")
  const pass2 = await applyOwnerPrices(container, scope)
  logger.info(`pass2 result: ok=${pass2.ok} added=${pass2.added} updated=${pass2.updated} skipped=${pass2.skipped}`)
  if ((pass2 as any).error) logger.error(`pass2 error: ${(pass2 as any).error}`)
  logger.info(`pass2 skip_reasons: ${JSON.stringify(pass2.skip_reasons ?? {})}`)
  logger.info("")

  logger.info("── AFTER pass 2 ──")
  const afterTwo = await samplePrice("after-pass-2")
  const changed2 = afterOne.firstAmount !== afterTwo.firstAmount
  logger.info(`changed by pass 2: ${changed2 ? "✓ YES" : "❌ NO"} (${afterOne.firstAmount} → ${afterTwo.firstAmount})`)

  logger.info("")
  logger.info("═══ SUMMARY ═══")
  if (changed1 && !changed2) {
    logger.info("✓ HEALTHY — pass 1 already takes; pass 2 is a no-op. No 'two applies' bug.")
  } else if (!changed1 && changed2) {
    logger.error("❌ CONFIRMED 'two applies' bug — pass 1 reports success but doesn't change values; pass 2 does")
  } else if (changed1 && changed2) {
    logger.warn("⚠ Both passes changed values — this is suspicious; expected pass 2 to be idempotent.")
  } else {
    logger.warn("⚠ Neither pass changed values — markup may not differ from what's stored. Try setting a new markup first.")
  }
}

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * One-off — rebuild the line_results for invoice 20260605-093116945
 * from the live catalog. The original Save deletes the failed-attempt
 * record's prior line_results (find-or-create replace), so we lost the
 * audit-trail entry that "28 strains were received". Their products
 * still exist; this script walks each product and re-creates a
 * SaveRowResult-shaped entry with real numbers (qtyQps, landed_per_qp,
 * sell prices) pulled from the current catalog state. The 2 failed
 * strains (Candy Runtz, Lime Sherb) are skipped — those will land
 * cleanly via the 2-row retry after this script runs.
 *
 * After this script, the receiving_record carries 28 reconstructed
 * entries. The subsequent 2-row save merges + you end up with 30,
 * and Push to QuickBooks bills the full invoice correctly.
 *
 * Usage:
 *   DIAG_INVOICE='20260605-093116945' pnpm reconstruct:receiving-history
 */

const INVOICE = process.env.DIAG_INVOICE || "20260605-093116945"

/* The 28 strains the audit confirmed survived in catalog after
 * Record #1's first save. Pairs of [strainName, tier].
 * Tier labels match flower tier handles (lowercase). */
const STRAINS: Array<[string, "classic" | "exotic" | "super" | "snow" | "rapper"]> = [
  ["Blackberry", "classic"],
  ["Gary Payton", "classic"],
  ["Gelato", "classic"],
  ["Blueberry Cake", "classic"],
  ["Cherry Souffle", "classic"],
  ["Purple Pancake", "exotic"],
  ["Candy Paint", "exotic"],
  ["Sangria Runtz", "exotic"],
  ["Frozen Sherblato", "exotic"],
  ["Blizzard Bars", "exotic"],
  ["Reeces Pieces", "exotic"],
  ["Purple Widow", "exotic"],
  ["Purple Punch", "exotic"],
  ["Jello Shot", "exotic"],
  ["Italian Ice", "rapper"],
  ["Illemonati", "super"],
  ["Red Velvet", "super"],
  ["Sour OG", "super"],
  ["Its a Secret", "super"],
  ["Mule Fuel Og", "rapper"],
  ["LA Runtz", "super"],
  ["Face on Fire", "super"],
  ["Julius Ceasar", "super"],
  ["Jealous Banana", "rapper"],
  ["Dank Sinatra", "rapper"],
  ["Red Sangria", "rapper"],
  ["Pineapple Fanta", "rapper"],
  ["Purple Tesla", "super"],
]

const TIER_LABELS = {
  classic: "Classic", exotic: "Exotic", super: "Super",
  snow: "Snowcaps", rapper: "Rapper",
} as const

export default async function reconstructReceivingHistory({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)
  const inventoryService: any = container.resolve(Modules.INVENTORY)

  logger.info(`═══ RECONSTRUCT RECEIVING HISTORY — invoice ${INVOICE} ═══`)

  const records = await history.listReceivingRecords({ invoice_number: [INVOICE] }, { take: 1 })
  const record = records?.[0]
  if (!record) {
    logger.error(`❌ No receiving_record for invoice "${INVOICE}". Aborting.`)
    return
  }
  logger.info(`Target record: ${record.id} · current line_results count: ${(record.line_results ?? []).length}`)

  const reconstructed: any[] = []
  let total_qps_reconstructed = 0
  let missingCount = 0

  for (const [strainName, tier] of STRAINS) {
    /* Look up the product by exact title. Catalog has unique titles
     * (we don't allow same strain at same tier — and these are all
     * different strain names regardless). */
    const { data: products } = await query.graph({
      entity: "product",
      fields: [
        "id", "handle", "title",
        "categories.id", "categories.name", "categories.handle", "categories.parent_category_id",
        "variants.id", "variants.title", "variants.sku",
        "variants.price_set.prices.amount", "variants.price_set.prices.currency_code",
        "variants.inventory_items.required_quantity",
        "variants.inventory_items.inventory.id",
        "variants.inventory_items.inventory.metadata",
        "variants.inventory_items.inventory.location_levels.stocked_quantity",
      ],
      filters: { title: strainName },
    })
    const p = (products as any[])?.[0]
    if (!p) {
      logger.warn(`  ⚠ "${strainName}" — no product in catalog. Skipping.`)
      missingCount += 1
      continue
    }

    /* Pull inventory + cost from the QP variant (the pool unit for flower). */
    const variants = (p.variants ?? []) as any[]
    const qpVariant = variants.find((v) => (v.sku ?? "").toLowerCase().endsWith("-qp")) ?? variants[0]
    const inv = qpVariant?.inventory_items?.[0]?.inventory
    const invMeta = inv?.metadata ?? {}
    const stockLevel = (inv?.location_levels ?? [])[0]
    const qtyQps = Number(stockLevel?.stocked_quantity ?? 0)
    const landedPerQp = Number(invMeta?.landed_per_qp ?? 0)
    if (!inv?.id) {
      logger.warn(`  ⚠ "${strainName}" — product found but no inventory_item. Skipping.`)
      missingCount += 1
      continue
    }

    /* Sell prices keyed by sizeKey (qp / half / lb). */
    const sellPrices: Record<string, number> = {}
    for (const v of variants) {
      const sizeKey = (v.sku ?? "").toLowerCase().split("-").slice(-1)[0]
      const usd = (v.price_set?.prices ?? []).find((p: any) => p?.currency_code?.toLowerCase() === "usd")
      if (sizeKey && typeof usd?.amount === "number") {
        sellPrices[sizeKey] = Number(usd.amount)
      }
    }

    /* baseSku = QP variant's SKU with size suffix stripped. */
    const baseSku = String(qpVariant?.sku ?? "").replace(/-qp$/i, "")

    /* categoryPath = [parent, leaf] from product.categories. */
    const cats = (p.categories ?? []) as Array<{ name?: string; parent_category_id?: string | null }>
    const leafCat = cats.find((c) => c?.parent_category_id)
    const parentCat = cats.find((c) => !c?.parent_category_id)
    const categoryPath = [parentCat?.name, leafCat?.name].filter(Boolean) as string[]

    /* lb sell price = inputUnitSellPrice for flower (lb is the operator's
     * input unit). Read off the lb variant. */
    const lbVariant = variants.find((v) => (v.sku ?? "").toLowerCase().endsWith("-lb"))
    const lbUsd = (lbVariant?.price_set?.prices ?? []).find((p: any) => p?.currency_code?.toLowerCase() === "usd")

    const entry = {
      strainName,
      tier,
      tierLabel: TIER_LABELS[tier],
      poolUnitLabel: "QP",
      action: "created" as const,
      productId: p.id,
      productHandle: p.handle,
      inventoryItemId: inv.id,
      baseSku,
      qtyQps,
      landedPerQp,
      sellPrices: Object.keys(sellPrices).length > 0 ? sellPrices : null,
      inputToPoolMultiplier: 4,
      inputUnitLabel: "lb",
      inputUnitSellPrice: typeof lbUsd?.amount === "number" ? Number(lbUsd.amount) : undefined,
      categoryPath,
    }
    reconstructed.push(entry)
    total_qps_reconstructed += qtyQps
    logger.info(`  ✓ "${strainName}" (${tier}) — qty=${qtyQps}QP · landed=$${landedPerQp.toFixed(4)} · prod=${p.id}`)
  }

  logger.info(`Reconstructed ${reconstructed.length} entries · ${missingCount} skipped (missing in catalog) · ${total_qps_reconstructed} total QPs`)

  /* Merge with existing line_results — preserve anything already there
   * (the 2 failed entries from the latest save), prefer reconstructed
   * for the 28 strains. Latest wins per strain name. */
  const prior = (record.line_results ?? []) as Array<{ strainName: string }>
  const byStrain = new Map<string, any>()
  for (const r of prior) byStrain.set(String(r.strainName ?? ""), r)
  for (const r of reconstructed) byStrain.set(String(r.strainName ?? ""), r)
  const merged = Array.from(byStrain.values())
  const merged_total_qps = merged.reduce((s, r: any) => s + (r.qtyQps || 0), 0)

  logger.info(`Final line_results count: ${merged.length} · total_qps: ${merged_total_qps}`)

  await history.updateReceivingRecords([{
    id: record.id,
    line_results: merged,
    total_qps: merged_total_qps,
  }])
  logger.info(`✓ Updated receiving_record ${record.id}`)
  logger.info("═══ DONE ═══")
}

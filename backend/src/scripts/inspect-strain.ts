import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * Inspect — prints everything material about a single strain's
 * inventory + pricing state: stocked quantity, landed cost, variant
 * SKUs + sell prices, PriceList entries (Distro / Owner Stores) if
 * they cover this strain.
 *
 * Usage:
 *   DIAG_HANDLE='lime-sherb' pnpm inspect:strain
 *   DIAG_HANDLE='rapper-lime-sherb' pnpm inspect:strain   (tier-prefixed)
 */

const HANDLE = process.env.DIAG_HANDLE || ""

export default async function inspectStrain({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingService: any = container.resolve(Modules.PRICING)

  if (!HANDLE) {
    logger.error("❌ DIAG_HANDLE env var required (e.g. lime-sherb)")
    return
  }

  logger.info(`═══ INSPECT STRAIN — handle="${HANDLE}" ═══`)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "handle", "title", "status",
      "categories.id", "categories.name", "categories.handle",
      "variants.id", "variants.title", "variants.sku",
      "variants.metadata",
      "variants.price_set.id",
      "variants.price_set.prices.id", "variants.price_set.prices.amount", "variants.price_set.prices.currency_code",
      "variants.inventory_items.required_quantity",
      "variants.inventory_items.inventory.id",
      "variants.inventory_items.inventory.sku",
      "variants.inventory_items.inventory.metadata",
      "variants.inventory_items.inventory.location_levels.id",
      "variants.inventory_items.inventory.location_levels.stocked_quantity",
      "variants.inventory_items.inventory.location_levels.reserved_quantity",
      "variants.inventory_items.inventory.location_levels.location_id",
    ],
    filters: { handle: HANDLE },
  })

  const p = (products as any[])?.[0]
  if (!p) {
    logger.error(`❌ No product with handle "${HANDLE}". Try a different slug or check spelling.`)
    return
  }

  logger.info(`Product: ${p.title}  ·  id=${p.id}  ·  status=${p.status}`)
  logger.info(`Categories: ${(p.categories ?? []).map((c: any) => c.name).join(" → ")}`)
  logger.info("")

  /* Pool inventory — shared across all variants for receiving products. */
  const firstInv = p.variants?.[0]?.inventory_items?.[0]?.inventory
  if (firstInv) {
    logger.info(`── Pool Inventory ──`)
    logger.info(`  inventory_item.id:   ${firstInv.id}`)
    logger.info(`  inventory_item.sku:  ${firstInv.sku}`)
    logger.info(`  landed_per_qp:       $${Number(firstInv.metadata?.landed_per_qp ?? 0).toFixed(4)}`)
    for (const lvl of (firstInv.location_levels ?? []) as any[]) {
      logger.info(`  location_id=${lvl.location_id}`)
      logger.info(`    stocked:  ${lvl.stocked_quantity}`)
      logger.info(`    reserved: ${lvl.reserved_quantity}`)
      logger.info(`    available: ${Number(lvl.stocked_quantity ?? 0) - Number(lvl.reserved_quantity ?? 0)}`)
    }
    logger.info("")
  }

  /* Variant-level prices + SKUs. */
  logger.info(`── Variants ──`)
  const priceSetIds: string[] = []
  for (const v of (p.variants ?? []) as any[]) {
    const usd = (v.price_set?.prices ?? []).find((pr: any) => pr?.currency_code?.toLowerCase() === "usd")
    const reqQty = v.inventory_items?.[0]?.required_quantity ?? "?"
    logger.info(`  "${v.title}" · sku=${v.sku} · USD=${usd?.amount ?? "—"} · required_qty=${reqQty}`)
    if (v.price_set?.id) priceSetIds.push(v.price_set.id)
  }
  logger.info("")

  /* PriceList entries hitting this strain. Useful to verify Distro /
   * Owner Stores prices are in place. */
  if (priceSetIds.length > 0) {
    const { data: priceListRows } = await query.graph({
      entity: "price_list",
      fields: ["id", "title", "status", "type", "prices.id", "prices.amount", "prices.price_set_id"],
      filters: {},
    })
    const matchingByList: Record<string, any[]> = {}
    for (const pl of (priceListRows as any[]) ?? []) {
      const hits = ((pl.prices ?? []) as any[]).filter((pp) => priceSetIds.includes(String(pp.price_set_id)))
      if (hits.length > 0) {
        matchingByList[`${pl.title} (${pl.status}/${pl.type})`] = hits
      }
    }
    if (Object.keys(matchingByList).length > 0) {
      logger.info(`── PriceList overrides for this strain ──`)
      for (const [label, hits] of Object.entries(matchingByList)) {
        logger.info(`  ${label}:`)
        for (const h of hits) {
          /* Find the matching variant for this price_set_id. */
          const v = (p.variants ?? []).find((vv: any) => vv?.price_set?.id === h.price_set_id)
          const amtNum = Number((h.amount as any)?.value ?? (h.amount as any)?.numeric ?? h.amount)
          logger.info(`    ${v?.title ?? "?"} · price_set=${h.price_set_id} · amount=$${amtNum}`)
        }
      }
    } else {
      logger.info(`── No PriceList overrides for this strain ──`)
    }
  }

  logger.info("")
  logger.info("═══ END ═══")
}

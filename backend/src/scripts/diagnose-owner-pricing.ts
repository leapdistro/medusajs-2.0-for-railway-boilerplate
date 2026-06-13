import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"

/**
 * One-off diagnostic — prints the state of the Owner Stores pricing
 * chain end-to-end for a specific customer + product. Use when "owner
 * prices not updating" to see exactly which step breaks.
 *
 * Run with: pnpm medusa exec ./src/scripts/diagnose-owner-pricing.ts
 *
 * Edit CUSTOMER_EMAIL + PRODUCT_HANDLE below before running.
 */

const CUSTOMER_EMAIL = process.env.DIAG_EMAIL || "wsscustomerservice@gmail.com"
const PRODUCT_HANDLE = process.env.DIAG_HANDLE || ""

export default async function diagnoseOwnerPricing({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const customerService: any = container.resolve(Modules.CUSTOMER)
  const pricingService: any = container.resolve(Modules.PRICING)

  logger.info("═══ OWNER STORES PRICING DIAGNOSTIC ═══")
  logger.info(`Customer email: ${CUSTOMER_EMAIL}`)
  logger.info(`Product handle: ${PRODUCT_HANDLE || "(none — will skip variant lookups)"}`)
  logger.info("")

  /* ─── Step 1: Customer + groups ─────────────────────────────── */
  logger.info("── Step 1: Customer lookup ──")
  const [customer] = await customerService
    .listCustomers({ email: [CUSTOMER_EMAIL] }, { take: 1, relations: ["groups"] })
    .catch(() => [])

  if (!customer) {
    logger.error(`❌ No customer with email "${CUSTOMER_EMAIL}". Edit DIAG_EMAIL env var.`)
    return
  }
  logger.info(`✓ Customer id: ${customer.id}`)
  logger.info(`  metadata.pricing_mode: ${JSON.stringify(customer.metadata?.pricing_mode)}`)
  logger.info(`  groups (relation):`)
  const groups = (customer.groups ?? []) as Array<{ id?: string; name?: string }>
  if (groups.length === 0) {
    logger.error("  ❌ Customer is in ZERO groups — group sync from /admin/customers/:id/pricing-mode failed silently.")
  } else {
    for (const g of groups) logger.info(`    - ${g.name} (${g.id})`)
  }
  const inOwnerStores = groups.some((g) => g.name === "owner_stores")
  logger.info(`  in owner_stores group: ${inOwnerStores ? "✓ YES" : "❌ NO"}`)
  logger.info("")

  /* ─── Step 2: Owner Stores PriceList ─────────────────────────── */
  logger.info("── Step 2: Owner Stores PriceList ──")
  const priceLists = await pricingService.listPriceLists(
    { title: ["Owner Stores Pricing"] },
    { take: 5 },
  ).catch(() => [])
  if (!priceLists?.length) {
    logger.error("❌ No PriceList titled 'Owner Stores Pricing' — apply has never run successfully.")
    return
  }
  const pl = priceLists[0]
  logger.info(`✓ PriceList id: ${pl.id}`)
  logger.info(`  status: ${pl.status}`)
  logger.info(`  type:   ${pl.type}`)
  logger.info(`  raw rules: ${JSON.stringify(pl.rules)}`)

  /* Pull the price_list with rules + prices expanded via query.graph. */
  const { data: plExpanded } = await query.graph({
    entity: "price_list",
    fields: [
      "id",
      "price_list_rules.attribute", "price_list_rules.value",
      "prices.id", "prices.amount", "prices.price_set_id",
    ],
    filters: { id: pl.id },
  })
  const plRow = (plExpanded as any[])?.[0]
  const ruleRows = (plRow?.price_list_rules ?? []) as Array<{ attribute?: string; value?: any }>
  logger.info(`  price_list_rules rows (${ruleRows.length}):`)
  for (const r of ruleRows) {
    logger.info(`    attribute=${r.attribute} value=${JSON.stringify(r.value)}`)
  }
  const ruleMatches = ruleRows.some((r) => {
    if (r.attribute !== "customer.groups.id") return false
    const v = r.value
    const owner = groups.find((g) => g.name === "owner_stores")
    if (!owner) return false
    if (Array.isArray(v)) return v.includes(owner.id)
    return String(v) === owner.id
  })
  logger.info(`  rule matches customer's owner_stores group: ${ruleMatches ? "✓ YES" : "❌ NO"}`)
  const priceCount = (plRow?.prices ?? []).length
  logger.info(`  prices on list: ${priceCount}`)
  logger.info("")

  if (!PRODUCT_HANDLE) {
    logger.info("(set DIAG_HANDLE env var to a product handle to test calculated_price for one variant)")
    return
  }

  /* ─── Step 2b: Landed cost + expected owner price ──────────────── */
  logger.info(`── Step 2b: landed cost + computed owner price for "${PRODUCT_HANDLE}" ──`)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)
  const flowerMarkup = Number(await settings.getSetting("flower_owner_markup_per_qp").catch(() => 0))
  const prerollMarkup = Number(await settings.getSetting("preroll_owner_markup_per_box").catch(() => 0))
  logger.info(`  current markups — flower: $${flowerMarkup}/qp · pre-roll: $${prerollMarkup}/box`)

  const { data: variantRows } = await query.graph({
    entity: "product_variant",
    fields: [
      "id", "title", "sku", "metadata",
      "product.handle",
      "price_set.id",
      "inventory_items.inventory.metadata",
    ],
    filters: { "product.handle": PRODUCT_HANDLE, deleted_at: null },
  })
  if (!variantRows?.length) {
    logger.error(`❌ No variants found for handle "${PRODUCT_HANDLE}"`)
  } else {
    const SIZE_POOL_UNITS: Record<string, number> = {
      qp: 1, half: 2, lb: 4, "30pk": 1, "15pk": 1,
    }
    for (const v of variantRows as any[]) {
      const invMeta = v.inventory_items?.[0]?.inventory?.metadata ?? null
      const landed = Number(invMeta?.landed_per_qp)
      const sizeKey: string | null = typeof v.metadata?.size_key === "string" ? v.metadata.size_key : null
      const poolUnits = sizeKey ? SIZE_POOL_UNITS[sizeKey] : null
      const isFlowerSize = sizeKey && ["qp", "half", "lb"].includes(sizeKey)
      const markup = isFlowerSize ? flowerMarkup : prerollMarkup
      logger.info(`  variant "${v.title}":`)
      logger.info(`    metadata.size_key:                   ${sizeKey ?? "(missing)"}`)
      logger.info(`    pool_units multiplier:               ${poolUnits ?? "(unmapped)"}`)
      logger.info(`    inventory_item.landed_per_qp:        ${Number.isFinite(landed) ? "$" + landed : "(missing)"}`)
      if (Number.isFinite(landed) && poolUnits) {
        const expected = (landed + markup) * poolUnits
        logger.info(`    EXPECTED owner price = (${landed} + ${markup}) × ${poolUnits} = $${expected.toFixed(2)}`)
      } else {
        logger.info(`    EXPECTED owner price: cannot compute (missing cost or size_key)`)
      }
    }
  }
  logger.info("")

  /* ─── Step 3: Calculated price for a real variant ─────────────── */
  logger.info(`── Step 3: calculated_price test for product "${PRODUCT_HANDLE}" ──`)
  const customerGroupIds = groups.map((g) => g.id).filter((id): id is string => Boolean(id))

  const flatCtx = { currency_code: "usd", "customer.groups.id": customerGroupIds }
  const nestedCtx = { currency_code: "usd", customer: { groups: customerGroupIds.map((id) => ({ id })) } }

  for (const [label, ctx] of [["FLAT (wrong)", flatCtx], ["NESTED (correct)", nestedCtx]] as const) {
    logger.info(`  ── context shape: ${label} ──`)
    try {
      const { QueryContext } = await import("@medusajs/framework/utils")
      const { data: products } = await query.graph({
        entity: "product",
        fields: [
          "id", "title",
          "variants.id", "variants.title",
          "variants.price_set.prices.amount", "variants.price_set.prices.currency_code",
          "variants.calculated_price.calculated_amount",
          "variants.calculated_price.original_amount",
          "variants.calculated_price.is_calculated_price_price_list",
        ],
        filters: { handle: PRODUCT_HANDLE },
        context: { variants: { calculated_price: QueryContext(ctx as any) } },
      })
      const p = (products as any[])?.[0]
      if (!p) {
        logger.warn(`  No product matched handle "${PRODUCT_HANDLE}"`)
        continue
      }
      for (const v of (p.variants ?? []) as any[]) {
        const usd = (v.price_set?.prices ?? []).find((pp: any) => pp?.currency_code?.toLowerCase() === "usd")
        const calc = v.calculated_price
        logger.info(`    variant "${v.title}":`)
        logger.info(`      default price (price_set):           ${usd?.amount ?? "—"}`)
        logger.info(`      calculated_price.calculated_amount:  ${calc?.calculated_amount ?? "null"}`)
        logger.info(`      is_calculated_price_price_list:      ${calc?.is_calculated_price_price_list ?? "—"}`)
      }
    } catch (e: any) {
      logger.error(`  context call threw: ${e?.message}`)
    }
    logger.info("")
  }
  logger.info("═══ END DIAGNOSTIC ═══")
}

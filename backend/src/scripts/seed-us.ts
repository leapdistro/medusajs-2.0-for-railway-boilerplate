import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createRegionsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * US setup — idempotent. Sets up everything cart + checkout needs:
 *   - USD as a supported currency on the store (default)
 *   - "United States" region with USD currency
 *   - Tax region for US (provider tp_system — returns 0%, fine for B2B
 *     where most orders are tax-exempt with resale certificate)
 *   - "MBS US Warehouse" stock location
 *   - Default shipping profile
 *   - Fulfillment set for US (UPS Ground / 2-Day / Next Day Air)
 *   - Sales channel linked to stock location
 *
 * Re-runnable safely — every step queries first, creates only if missing.
 *
 * Run with:  pnpm exec medusa exec ./src/scripts/seed-us.ts
 */
export default async function seedUsSetup({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)
  const regionService: any = container.resolve(Modules.REGION)
  const salesChannelService: any = container.resolve(Modules.SALES_CHANNEL)
  const stockLocationService: any = container.resolve(Modules.STOCK_LOCATION)
  const storeService: any = container.resolve(Modules.STORE)

  logger.info("=== US Setup starting ===")

  // ─── Store: ensure USD is supported + default ──────────────────────
  const [store] = await storeService.listStores()
  const supported = (store.supported_currencies ?? []) as Array<{ currency_code: string; is_default?: boolean }>
  const hasUsd = supported.some((c) => c.currency_code === "usd")
  const usdIsDefault = supported.some((c) => c.currency_code === "usd" && c.is_default)
  if (!hasUsd || !usdIsDefault) {
    const next = supported.map((c) => ({ ...c, is_default: false }))
    if (!hasUsd) next.push({ currency_code: "usd", is_default: true })
    else next.find((c) => c.currency_code === "usd")!.is_default = true
    await storeService.updateStores(store.id, { supported_currencies: next })
    logger.info("  · store: USD set as default currency")
  } else {
    logger.info("  · store: USD already default")
  }

  // ─── Region: United States with USD ────────────────────────────────
  const existingRegions = await regionService.listRegions(
    { name: "United States" },
    { relations: ["countries"] },
  )
  let usRegion = existingRegions[0]
  if (!usRegion) {
    const { result } = await createRegionsWorkflow(container).run({
      input: {
        regions: [{
          name: "United States",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        }],
      },
    })
    usRegion = result[0]
    logger.info(`  + region: United States (${usRegion.id})`)
  } else {
    logger.info(`  · region: United States exists (${usRegion.id})`)
    /* Ensure 'us' country is attached. Base seed sometimes creates the
     * region without countries; cart.update_addresses then 400s with
     * "Country with code us is not within region United States". */
    const countryCodes = (usRegion.countries ?? []).map((c: any) => c.iso_2)
    if (!countryCodes.includes("us")) {
      await regionService.updateRegions(usRegion.id, {
        countries: [...countryCodes.filter(Boolean), "us"],
      })
      logger.info(`  + region: added country 'us' (was: [${countryCodes.join(",")}])`)
    }
  }

  // ─── Tax region: US (provider tp_system) ───────────────────────────
  try {
    await createTaxRegionsWorkflow(container).run({
      input: [{ country_code: "us", provider_id: "tp_system" }],
    })
    logger.info("  + tax region: US")
  } catch (e: any) {
    // Throws if already exists — safe to ignore
    if (String(e?.message ?? "").toLowerCase().includes("already")) {
      logger.info("  · tax region: US exists")
    } else {
      logger.warn(`  ! tax region create skipped: ${e?.message}`)
    }
  }

  // ─── Stock location: MBS US Warehouse ──────────────────────────────
  const existingLocations = await stockLocationService.listStockLocations({ name: "MBS US Warehouse" })
  let warehouse = existingLocations[0]
  if (!warehouse) {
    const { result } = await createStockLocationsWorkflow(container).run({
      input: {
        locations: [{
          name: "MBS US Warehouse",
          address: {
            address_1: "",
            city: "Houston",
            country_code: "US",
            province: "TX",
            postal_code: "77002",
          },
        }],
      },
    })
    warehouse = result[0]
    logger.info(`  + stock location: MBS US Warehouse (${warehouse.id})`)
  } else {
    logger.info(`  · stock location: MBS US Warehouse exists (${warehouse.id})`)
  }

  // Set as store default location
  await updateStoresWorkflow(container).run({
    input: { selector: { id: store.id }, update: { default_location_id: warehouse.id } },
  })

  // ─── Link warehouse → fulfillment provider (manual_manual) ─────────
  // Skip on duplicate (link already exists)
  try {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: warehouse.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
    })
    logger.info("  + link: warehouse ↔ manual fulfillment")
  } catch {
    logger.info("  · link: warehouse ↔ manual fulfillment exists")
  }

  // ─── Shipping profile (default) ────────────────────────────────────
  const profiles = await fulfillmentService.listShippingProfiles({ type: "default" })
  let shippingProfile = profiles[0]
  if (!shippingProfile) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default Shipping Profile", type: "default" }] },
    })
    shippingProfile = result[0]
    logger.info(`  + shipping profile: Default (${shippingProfile.id})`)
  } else {
    logger.info(`  · shipping profile: Default exists (${shippingProfile.id})`)
  }

  // ─── Fulfillment set: US (with UPS service zone) ───────────────────
  // Expand `service_zones` so the existing-set branch knows the zone id —
  // the default list response doesn't include the relation, which made
  // shipping options silently skip on subsequent runs.
  const existingSets = await fulfillmentService.listFulfillmentSets(
    { name: "MBS US delivery" },
    { relations: ["service_zones"] },
  )
  let fulfillmentSet = existingSets[0]
  if (!fulfillmentSet) {
    fulfillmentSet = await fulfillmentService.createFulfillmentSets({
      name: "MBS US delivery",
      type: "shipping",
      service_zones: [{
        name: "United States",
        geo_zones: [{ country_code: "us", type: "country" }],
      }],
    })
    logger.info(`  + fulfillment set: MBS US delivery (${fulfillmentSet.id})`)

    // Link warehouse to this fulfillment set so it can serve shipping
    try {
      await link.create({
        [Modules.STOCK_LOCATION]: { stock_location_id: warehouse.id },
        [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
      })
    } catch {
      // already linked
    }
  } else {
    logger.info(`  · fulfillment set: MBS US delivery exists (${fulfillmentSet.id})`)
  }

  // ─── Shipping options (UPS Ground / 2-Day Air / Next Day Air) ──────
  const serviceZoneId = fulfillmentSet.service_zones?.[0]?.id
  if (!serviceZoneId) {
    logger.warn("  ! no service zone on fulfillment set — skipping shipping options")
  } else {
    const existingOptions = await fulfillmentService.listShippingOptions({ service_zone_id: serviceZoneId })
    const existingNames = new Set(existingOptions.map((o: { name: string }) => o.name))

    /* Amounts are in WHOLE USD units (matching variant prices) — Medusa
     * v2 doesn't use cents for these. Original seed had cents-style
     * values (1500/3500/6500) which displayed as $1,500/$3,500/$6,500
     * on the storefront — corrected here. fix-shipping-prices.ts can
     * repair existing options that were created with the wrong values. */
    const wantedOptions = [
      { name: "Local Pickup",      code: "local-pickup", amount: 0,  label: "Pickup",    description: "Pick up at MBS warehouse — call to schedule" },
      { name: "UPS Ground",        code: "ups-ground",   amount: 15, label: "Standard",  description: "5–7 business days" },
      { name: "UPS 2-Day Air",     code: "ups-2day",     amount: 35, label: "Express",   description: "2 business days" },
      { name: "UPS Next Day Air",  code: "ups-next-day", amount: 65, label: "Overnight", description: "Next business day" },
    ]

    const toCreate = wantedOptions.filter((o) => !existingNames.has(o.name))
    if (toCreate.length === 0) {
      logger.info("  · shipping options: all 4 exist")
    } else {
      await createShippingOptionsWorkflow(container).run({
        input: toCreate.map((o) => ({
          name: o.name,
          price_type: "flat" as const,
          provider_id: "manual_manual",
          service_zone_id: serviceZoneId,
          shipping_profile_id: shippingProfile.id,
          type: { label: o.label, description: o.description, code: o.code },
          prices: [{ currency_code: "usd", amount: o.amount }],
          rules: [
            { attribute: "enabled_in_store", value: "true",  operator: "eq" as const },
            { attribute: "is_return",        value: "false", operator: "eq" as const },
          ],
        })),
      })
      logger.info(`  + shipping options: ${toCreate.map((o) => o.name).join(", ")}`)
    }
  }

  // ─── Link sales channel(s) → stock location ────────────────────────
  const channels = await salesChannelService.listSalesChannels()
  for (const ch of channels) {
    try {
      await linkSalesChannelsToStockLocationWorkflow(container).run({
        input: { id: warehouse.id, add: [ch.id] },
      })
    } catch {
      // already linked — quiet
    }
  }
  logger.info(`  · sales channels linked to warehouse: ${channels.length}`)

  logger.info("=== US Setup complete ===")
}

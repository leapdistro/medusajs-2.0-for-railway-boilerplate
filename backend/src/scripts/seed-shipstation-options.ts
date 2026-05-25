import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createShippingOptionsWorkflow, deleteShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Swap the static (price_type: "flat") UPS shipping options seeded by
 * seed-us.ts for live-rate calculated options backed by the ShipStation
 * fulfillment provider.
 *
 * Net effect after running:
 *   - "UPS Ground"  → calculated via ShipStation (was $15 flat)
 *   - "UPS Next Day Air Saver" → calculated via ShipStation (replaces
 *     "UPS Next Day Air" $65 flat AND "UPS 2-Day Air" $35 flat — operator
 *     only ships Ground + NDA Saver, 2-Day Air retires)
 *   - "Local Pickup" → unchanged (free, flat, manual provider)
 *
 * Pre-reqs:
 *   - seed-us.ts has run (warehouse + fulfillment set + service zone exist)
 *   - SHIPSTATION_API_KEY + SHIPSTATION_API_SECRET set on Railway so the
 *     provider is registered (see medusa-config.js)
 *   - shipping_weights setting populated + applied to existing variants
 *     (otherwise checkout will hard-fail on missing variant.metadata.shipping_weight_lb)
 *
 * Idempotent — re-runnable. Detects existing calculated options by name
 * and skips creation; only retires legacy static options on the first run.
 *
 * Run via: pnpm exec medusa exec ./src/scripts/seed-shipstation-options.ts
 */
export default async function seedShipStationOptions({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)
  const stockLocationService: any = container.resolve(Modules.STOCK_LOCATION)
  const link = container.resolve(ContainerRegistrationKeys.LINK)

  logger.info("▶ Migrating UPS options to ShipStation calculated rates…")

  /* ─── 0. Link the ShipStation provider to the warehouse ─────
   * Medusa rejects "provider not enabled for service location" when
   * a shipping_option references a fulfillment provider that has no
   * link to the stock location backing the service zone. Mirrors the
   * `manual_manual` link created in seed-us.ts:136. */
  const warehouses = await stockLocationService.listStockLocations({}, { take: 1 })
  const warehouse = warehouses?.[0]
  if (!warehouse) {
    logger.error("No stock location found. Run `pnpm seed:us` first.")
    return
  }
  try {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: warehouse.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: "shipstation_shipstation" },
    })
    logger.info(`  + link: warehouse ↔ shipstation provider`)
  } catch {
    logger.info(`  · link: warehouse ↔ shipstation provider exists`)
  }

  /* ─── 1. Find the service zone (created by seed-us.ts) ──────── */
  const sets = await fulfillmentService.listFulfillmentSets(
    { name: "MBS US delivery" },
    { take: 1, relations: ["service_zones"] },
  )
  const set = sets?.[0]
  if (!set) {
    logger.error("Fulfillment set 'MBS US delivery' not found. Run `pnpm seed:us` first.")
    return
  }
  const serviceZoneId = set.service_zones?.[0]?.id
  if (!serviceZoneId) {
    logger.error("Service zone missing on fulfillment set. Run `pnpm seed:us` first.")
    return
  }

  /* ─── 2. Resolve the default shipping profile ──────────────── */
  const profiles = await fulfillmentService.listShippingProfiles({ type: "default" })
  const shippingProfile = profiles?.[0]
  if (!shippingProfile) {
    logger.error("No default shipping profile found. Run `pnpm seed:us` first.")
    return
  }

  /* ─── 3. Inventory current options + decide what to do ─────── */
  const existing = await fulfillmentService.listShippingOptions({ service_zone_id: serviceZoneId })
  const existingByName = new Map<string, any>(existing.map((o: any) => [o.name, o]))

  /* Retire all prior UPS options (static or calculated, any era). The
   * current model is ONE flat-rate calculated option "Standard Shipping"
   * backed by per-variant rate cents on variant.weight. */
  const RETIRE_NAMES = ["UPS Ground", "UPS 2-Day Air", "UPS Next Day Air", "UPS Next Day Air Saver"]

  const toRetire: string[] = []
  for (const name of RETIRE_NAMES) {
    const opt = existingByName.get(name)
    if (opt) toRetire.push(opt.id)
  }

  if (toRetire.length > 0) {
    await deleteShippingOptionsWorkflow(container).run({ input: { ids: toRetire } })
    logger.info(`  ✓ retired ${toRetire.length} legacy option(s): ${RETIRE_NAMES.filter((n) => existingByName.has(n)).join(", ")}`)
  } else {
    logger.info("  · no legacy options to retire")
  }

  /* ─── 4. Create the one calculated option ─────────────────── */
  /* Refetch after the delete so the name-set is current. */
  const after = await fulfillmentService.listShippingOptions({ service_zone_id: serviceZoneId })
  const afterNames = new Set(after.map((o: any) => o.name))

  const newOptions = [
    {
      name: "Standard Shipping",
      code: "standard-shipping",
      label: "Standard",
      description: "Flat shipping rate, computed per cart from per-variant rates",
      service_code: "standard" as const,
    },
  ]
  const toCreate = newOptions.filter((o) => !afterNames.has(o.name))

  if (toCreate.length === 0) {
    logger.info("  · both calculated options already exist — nothing to create")
  } else {
    await createShippingOptionsWorkflow(container).run({
      input: toCreate.map((o) => ({
        name: o.name,
        /* "calculated" tells Medusa to defer pricing to the provider's
         * calculatePrice() call at cart-time. */
        price_type: "calculated" as const,
        /* Container key = `fp_${identifier}_${id}` for fulfillment
         * providers. medusa-config.js sets id: "shipstation" on the
         * registration, mirroring the manual provider's `manual_manual`
         * pattern, so the resolved key is `fp_shipstation_shipstation`.
         * Medusa prepends `fp_` itself when resolving; pass
         * `shipstation_shipstation` here. */
        provider_id: "shipstation_shipstation",
        service_zone_id: serviceZoneId,
        shipping_profile_id: shippingProfile.id,
        type: { label: o.label, description: o.description, code: o.code },
        /* Calculated options STILL need a (zero) prices array — Medusa
         * validates the shape. Provider returns the real number per cart. */
        prices: [{ currency_code: "usd", amount: 0 }],
        /* The provider reads service_code from this `data` block on every
         * calculatePrice. */
        data: { service_code: o.service_code },
        rules: [
          { attribute: "enabled_in_store", value: "true",  operator: "eq" as const },
          { attribute: "is_return",        value: "false", operator: "eq" as const },
        ],
      })),
    })
    logger.info(`  + created: ${toCreate.map((o) => o.name).join(", ")}`)
  }

  logger.info("─────────────────────────────────")
  logger.info("✓ ShipStation calculated options live.")
  logger.info("  Reminder: shipping_weights setting must be populated AND applied to existing variants,")
  logger.info("  otherwise checkout will reject the cart with 'Missing shipping weight on variant(s)'.")
}

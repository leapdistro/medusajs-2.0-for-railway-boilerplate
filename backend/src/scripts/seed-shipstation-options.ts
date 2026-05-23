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

  logger.info("▶ Migrating UPS options to ShipStation calculated rates…")

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

  /* Legacy static options to retire. Local Pickup stays as-is. */
  const RETIRE_NAMES = ["UPS Ground", "UPS 2-Day Air", "UPS Next Day Air"]
  /* New calculated options (and the canonical name for NDA Saver). */
  const WANTED_NAMES = ["UPS Ground", "UPS Next Day Air Saver"]

  const toRetire: string[] = []
  for (const name of RETIRE_NAMES) {
    const opt = existingByName.get(name)
    if (!opt) continue
    /* Skip if already calculated + provider already ShipStation — that
     * means a prior run handled it. */
    if (opt.price_type === "calculated" && String(opt.provider_id ?? "").includes("shipstation")) {
      continue
    }
    toRetire.push(opt.id)
  }

  if (toRetire.length > 0) {
    await deleteShippingOptionsWorkflow(container).run({ input: { ids: toRetire } })
    logger.info(`  ✓ retired ${toRetire.length} legacy option(s): ${RETIRE_NAMES.filter((n) => existingByName.has(n)).join(", ")}`)
  } else {
    logger.info("  · no legacy options to retire")
  }

  /* ─── 4. Create the two calculated options ─────────────────── */
  /* Refetch after the delete so the name-set is current. */
  const after = await fulfillmentService.listShippingOptions({ service_zone_id: serviceZoneId })
  const afterNames = new Set(after.map((o: any) => o.name))

  const newOptions = [
    {
      name: "UPS Ground",
      code: "ups-ground",
      label: "Standard",
      description: "Live UPS Ground rate (with adult signature + insurance)",
      service_code: "ups_ground" as const,
    },
    {
      name: "UPS Next Day Air Saver",
      code: "ups-next-day-air-saver",
      label: "Overnight",
      description: "Live UPS Next Day Air Saver rate (with adult signature + insurance)",
      service_code: "ups_next_day_air_saver" as const,
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

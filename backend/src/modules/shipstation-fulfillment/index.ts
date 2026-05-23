import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import ShipStationFulfillmentService from "./service"

/**
 * ShipStation fulfillment provider — wraps ShipStation's Rates API so
 * the storefront's checkout shipping options return live UPS Ground +
 * Next Day Air Saver rates with adult-signature confirmation + carrier
 * insurance (60% × invoice subtotal).
 *
 * Wire-up in medusa-config.js, alongside the seeded manual provider:
 *
 *   modules: [
 *     {
 *       resolve: "@medusajs/medusa/fulfillment",
 *       options: {
 *         providers: [
 *           { resolve: "@medusajs/fulfillment-manual", id: "manual" },
 *           { resolve: "./src/modules/shipstation-fulfillment", id: "shipstation" },
 *         ],
 *       },
 *     },
 *   ]
 *
 * Provider container key resolves to `sp_shipstation_shipstation`
 * (`sp_${identifier}_${id}`) — the existing seeded options reference the
 * manual provider as `manual_manual`; new shipping options created by
 * seed-shipstation-options.ts reference the new key.
 */
export default ModuleProvider(Modules.FULFILLMENT, {
  services: [ShipStationFulfillmentService],
})

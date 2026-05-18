import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import KajaAuthnetProviderService from "./service"

/**
 * KAJA / Authorize.net payment provider module — registers
 * KajaAuthnetProviderService under the standard Medusa Payment module
 * so it shows up alongside any other configured providers in
 * /store/payment-providers and the admin payment-provider picker.
 *
 * Wire-up in medusa-config.js:
 *
 *   modules: [
 *     {
 *       resolve: "@medusajs/medusa/payment",
 *       options: {
 *         providers: [
 *           { resolve: "./src/modules/kaja-authnet", id: "kaja-authnet" },
 *         ],
 *       },
 *     },
 *   ]
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [KajaAuthnetProviderService],
})

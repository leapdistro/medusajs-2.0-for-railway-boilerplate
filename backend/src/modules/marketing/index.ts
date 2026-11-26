import { Module } from "@medusajs/framework/utils"
import MarketingModuleService from "./service"

export const MARKETING_MODULE = "marketing"

export default Module(MARKETING_MODULE, {
  service: MarketingModuleService,
})

import { Module } from "@medusajs/framework/utils"
import MbsAttributesModuleService from "./service"

export const MBS_ATTRIBUTES_MODULE = "mbsAttributesModuleService"

export default Module(MBS_ATTRIBUTES_MODULE, {
  service: MbsAttributesModuleService,
})

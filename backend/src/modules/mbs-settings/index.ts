import { Module } from "@medusajs/framework/utils"
import MbsSettingsModuleService from "./service"

export const MBS_SETTINGS_MODULE = "mbsSettingsModuleService"

export default Module(MBS_SETTINGS_MODULE, {
  service: MbsSettingsModuleService,
})

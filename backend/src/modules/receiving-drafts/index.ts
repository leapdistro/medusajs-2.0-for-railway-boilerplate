import { Module } from "@medusajs/framework/utils"
import ReceivingDraftsModuleService from "./service"

/* Module key kept short + lowercase so `medusa db:generate receiving_drafts`
 * works without aliasing. */
export const RECEIVING_DRAFTS_MODULE = "receiving_drafts"

export default Module(RECEIVING_DRAFTS_MODULE, {
  service: ReceivingDraftsModuleService,
})

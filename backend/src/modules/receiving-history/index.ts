import { Module } from "@medusajs/framework/utils"
import ReceivingHistoryModuleService from "./service"

/* Module key short + lowercase so `medusa db:generate receiving_history` works. */
export const RECEIVING_HISTORY_MODULE = "receiving_history"

export default Module(RECEIVING_HISTORY_MODULE, {
  service: ReceivingHistoryModuleService,
})

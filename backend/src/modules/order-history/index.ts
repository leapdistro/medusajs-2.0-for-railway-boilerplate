import { Module } from "@medusajs/framework/utils"
import OrderHistoryModuleService from "./service"

export const ORDER_HISTORY_MODULE = "order_history"

export default Module(ORDER_HISTORY_MODULE, {
  service: OrderHistoryModuleService,
})

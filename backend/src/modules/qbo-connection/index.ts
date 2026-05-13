import { Module } from "@medusajs/framework/utils"
import QboConnectionModuleService from "./service"

export const QBO_CONNECTION_MODULE = "qbo_connection"

export default Module(QBO_CONNECTION_MODULE, {
  service: QboConnectionModuleService,
})

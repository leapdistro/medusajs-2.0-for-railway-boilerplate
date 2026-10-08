import { Module } from "@medusajs/framework/utils"
import QboSyncModuleService from "./service"

export const QBO_SYNC_MODULE = "qbo_sync"

export default Module(QBO_SYNC_MODULE, {
  service: QboSyncModuleService,
})

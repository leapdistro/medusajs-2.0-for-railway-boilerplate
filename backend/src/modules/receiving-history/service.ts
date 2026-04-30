import { MedusaService } from "@medusajs/framework/utils"
import { ReceivingRecord } from "./models/receiving-record"

/**
 * Receiving history service. Inherits CRUD (listReceivingRecords,
 * createReceivingRecords, etc.) — the save handler is the only writer
 * and the future receiving-history admin page is the only reader, so
 * no custom helpers needed here.
 */
class ReceivingHistoryModuleService extends MedusaService({
  ReceivingRecord,
}) {}

export default ReceivingHistoryModuleService

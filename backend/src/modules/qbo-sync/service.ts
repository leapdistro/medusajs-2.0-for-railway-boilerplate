import { MedusaService } from "@medusajs/framework/utils"
import { QboSyncJob } from "./models/qbo-sync-job"

class QboSyncModuleService extends MedusaService({
  QboSyncJob,
}) {}

export default QboSyncModuleService

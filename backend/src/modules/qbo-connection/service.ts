import { MedusaService } from "@medusajs/framework/utils"
import { QboConnection } from "./models/qbo-connection"

class QboConnectionModuleService extends MedusaService({
  QboConnection,
}) {}

export default QboConnectionModuleService

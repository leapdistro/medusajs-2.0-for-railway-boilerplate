import { MedusaService } from "@medusajs/framework/utils"
import { OrderHistoryEvent } from "./models/order-history-event"

class OrderHistoryModuleService extends MedusaService({
  OrderHistoryEvent,
}) {}

export default OrderHistoryModuleService

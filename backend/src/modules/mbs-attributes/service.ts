import { MedusaService } from "@medusajs/framework/utils"
import { ProductAttributes } from "./models/product-attributes"

class MbsAttributesModuleService extends MedusaService({
  ProductAttributes,
}) {}

export default MbsAttributesModuleService

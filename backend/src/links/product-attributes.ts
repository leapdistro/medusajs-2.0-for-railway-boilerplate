import { defineLink } from "@medusajs/framework/utils"
import ProductModule from "@medusajs/medusa/product"
import MbsAttributesModule from "../modules/mbs-attributes"

export default defineLink(
  ProductModule.linkable.product,
  MbsAttributesModule.linkable.productAttributes,
)

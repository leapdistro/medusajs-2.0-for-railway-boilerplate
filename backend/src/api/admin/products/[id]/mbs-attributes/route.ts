import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_ATTRIBUTES_MODULE } from "../../../../../modules/mbs-attributes"

type MbsAttributesPayload = {
  tier?: string | null
  strain_type?: string | null
  best_for?: string | null
  potency?: number | null
  thca_percent?: string | null
  total_cannabinoids_percent?: string | null
  effects?: string[] | null
  coa_url?: string | null
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id: productId } = req.params
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "product_attributes.*"],
    filters: { id: productId },
  })

  res.json({ attributes: data[0]?.product_attributes ?? null })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id: productId } = req.params
  const payload = req.body as MbsAttributesPayload

  const mbsService: any = req.scope.resolve(MBS_ATTRIBUTES_MODULE)
  const link = req.scope.resolve(ContainerRegistrationKeys.LINK)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "product_attributes.id"],
    filters: { id: productId },
  })

  const existing = data[0]?.product_attributes
  let attrs

  if (existing?.id) {
    attrs = await mbsService.updateProductAttributes({ id: existing.id, ...payload })
  } else {
    attrs = await mbsService.createProductAttributes(payload)
    await link.create({
      [Modules.PRODUCT]: { product_id: productId },
      [MBS_ATTRIBUTES_MODULE]: { product_attributes_id: attrs.id },
    })
  }

  res.json({ attributes: attrs })
}

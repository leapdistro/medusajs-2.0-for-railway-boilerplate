import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { searchProducts } from "../../../../lib/marketing/products"

/** GET /admin/marketing/products?q= — published products for the
 *  product picker, newest first. ?ids=a,b — those products (any status),
 *  for the picked list in a block. */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : ""
  const ids = typeof req.query.ids === "string"
    ? req.query.ids.split(",").filter((x) => /^prod_[A-Za-z0-9]{6,64}$/.test(x)).slice(0, 100)
    : []
  res.json({ products: await searchProducts(req.scope, q, q ? 60 : 80, ids) })
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../modules/mbs-settings"
import { loadCategoryTree, productPath } from "../../../../../lib/category-tree"
import { labelToken } from "../../../../../lib/label-link"

const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://hempmbs.com"

/**
 * Shelf-label print links for the receiving screens.
 *
 * `unit` is a receiving line's stock unit ("QP"): the label format whose
 * id, label or printed weight matches it is the one printed, so formats
 * stay in MBS Settings → Labels. A product prints only when its category
 * path has `labels` on.
 *
 * GET  ?productIds=a,b&unit=QP → { format, printable: { [productId]: boolean } }
 * POST { productId, unit }     → { url } (a storefront link valid for 30 minutes)
 */

async function resolve(req: MedusaRequest, productIds: string[], unitRaw: string) {
  const unit = unitRaw.trim().toLowerCase()
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)

  const formats = await settings.getSetting("label_formats").catch(() => null)
  const format = unit
    ? (Array.isArray(formats) ? formats : []).find((f: any) =>
        f?.id && f.archived !== true &&
        [f.id, f.label, f.weight_text].some((x: unknown) => String(x ?? "").trim().toLowerCase() === unit))
    : null

  const products = new Map<string, { handle: string; title: string; labels: boolean }>()
  if (productIds.length) {
    const [{ data }, tree] = await Promise.all([
      query.graph({ entity: "product", fields: ["id", "handle", "title", "categories.id"], filters: { id: productIds } }),
      loadCategoryTree(query),
    ])
    for (const p of data as any[]) {
      const path = productPath(tree, (p.categories ?? []).map((c: any) => c.id))
      let labels: unknown
      for (let i = path.length - 1; i >= 0 && labels === undefined; i--) {
        const v = path[i].metadata?.labels
        if (v !== undefined && v !== null && v !== "") labels = v
      }
      products.set(p.id, { handle: p.handle, title: p.title, labels: labels === true })
    }
  }
  return { format, products }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productIds = String(req.query.productIds ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500)
  const { format, products } = await resolve(req, productIds, String(req.query.unit ?? ""))
  return res.json({
    format: format ? { id: format.id, label: format.label ?? format.id } : null,
    printable: Object.fromEntries(productIds.map((id) => [id, !!format && !!products.get(id)?.labels])),
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as { productId?: string; unit?: string }
  const productId = String(body.productId ?? "")
  const unit = String(body.unit ?? "")
  if (!productId || !unit.trim()) return res.status(400).json({ error: "productId and unit are required" })

  const { format, products } = await resolve(req, [productId], unit)
  const product = products.get(productId)
  if (!product) return res.status(404).json({ error: "Product not found" })
  if (!product.labels) return res.status(400).json({ error: `${product.title}: its category doesn't print labels` })
  if (!format) return res.status(400).json({ error: `No label format called "${unit}" in MBS Settings → Labels` })

  const token = labelToken(product.handle, String(format.id))
  if (!token) return res.status(500).json({ error: "Label links aren't set up on this server (JWT_SECRET missing)" })
  const url = `${STOREFRONT_URL}/labels/${encodeURIComponent(product.handle)}/${encodeURIComponent(String(format.id))}?t=${encodeURIComponent(token)}`
  return res.json({ url })
}

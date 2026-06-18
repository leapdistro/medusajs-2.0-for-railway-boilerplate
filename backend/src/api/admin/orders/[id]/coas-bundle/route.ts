import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { buildCoaBundle } from "../../../../../lib/coa-bundle"

/**
 * GET /admin/orders/:id/coas-bundle
 *
 * Streams one combined PDF containing every unique product's COA from
 * this order. Mirrors the storefront `/api/account/orders/:id/coas-bundle`
 * route — operator gets the SAME PDF the buyer would, byte for byte.
 *
 * Dedupes by product handle, line-item order, silently skips products
 * without a COA, auto-converts image COAs. See lib/coa-bundle.ts.
 *
 * The COA proxy lives on the storefront (it resolves coaUrl from
 * mbs-attributes and streams the upstream PDF/image). We fetch through
 * it so the bundle resolves the same artifact buyers see — no
 * direct-to-bucket access from the backend. STOREFRONT_URL env var
 * drives the host (set to https://hempmbs.com in prod).
 */
const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://hempmbs.com"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const orderId = req.params.id
  if (!orderId) {
    return res.status(400).json({ ok: false, message: "Missing order id" })
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  /* Load enough order data to dedupe by product handle and label
   * skipped items for the operator. items.product.handle works
   * because the link from order line item → variant → product is
   * native in Medusa v2. */
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id",
      "items.id", "items.title", "items.product_title", "items.product_handle",
      "items.variant.product.handle",
    ],
    filters: { id: orderId },
  })
  const order = (orders as any[])[0]
  if (!order) {
    return res.status(404).json({ ok: false, message: "Order not found" })
  }

  /* Prefer items.product_handle (Medusa stamps it on the line item at
   * checkout); fall back to the joined variant.product.handle for
   * older orders or edge cases. */
  const items = ((order.items ?? []) as any[])
    .map((li) => ({
      handle: (li.product_handle ?? li.variant?.product?.handle ?? "") as string,
      label: (li.product_title ?? li.title ?? "") as string,
    }))
    .filter((it) => it.handle)

  if (items.length === 0) {
    return res.status(404).json({ ok: false, message: "No products with COAs in this order" })
  }

  let bundle
  try {
    bundle = await buildCoaBundle(items, STOREFRONT_URL)
  } catch (e: any) {
    logger.error(`[coas-bundle] order ${orderId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Bundle build failed" })
  }

  if (bundle.included.length === 0) {
    return res.status(404).json({ ok: false, message: "No COAs available for the products in this order" })
  }

  const orderNumber = order.display_id != null
    ? `MBS-${String(order.display_id).padStart(5, "0")}`
    : String(order.id).slice(0, 8).toUpperCase()
  const filename = `COAs-${orderNumber}.pdf`

  /* Medusa's MedusaResponse is wrapped around an express response.
   * Bytes go through .send(Buffer.from(...)) — sending the raw
   * Uint8Array works but Buffer.from() ensures a contiguous binary
   * payload that PDF viewers don't mis-parse. */
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`)
  res.setHeader("Cache-Control", "private, no-store")
  res.status(200).send(Buffer.from(bundle.pdf))
}

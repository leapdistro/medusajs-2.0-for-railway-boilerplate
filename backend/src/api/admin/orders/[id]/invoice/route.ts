import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { printToken } from "../../../../../lib/print-link"

const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://hempmbs.com"

/**
 * GET /admin/orders/:id/invoice
 *
 * Sends admin to the order's invoice PDF: the same one the buyer
 * downloads from My Account (storefront /api/account/orders/:id/invoice,
 * InvoicePDF), so there's one invoice layout. The storefront route
 * normally needs the buyer's sign-in; this redirect adds a token signed
 * for this one order, valid 30 minutes (lib/print-link.ts), which the
 * storefront checks with /store/mbs/orders/:id/invoice-link.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: ["id"], filters: { id: orderId } })
  if (!(data as any[])?.[0]) return res.status(404).json({ message: "Order not found" })

  const token = printToken("invoice-link", [orderId])
  if (!token) return res.status(500).json({ message: "Invoice links aren't set up on this server (JWT_SECRET missing)" })
  res.redirect(`${STOREFRONT_URL}/api/account/orders/${encodeURIComponent(orderId)}/invoice?t=${encodeURIComponent(token)}`)
}

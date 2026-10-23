import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { priceTableCatalog, shippingCatalog } from "../../../../lib/price-table-catalog"

/**
 * GET /admin/mbs/price-tables
 *   → { levels: [{ level, label, tables: [{ key, categories, rows, unit?, value }] }],
 *       shipping: { value, buckets: [{ key, categories, flat, rows, value }] } }
 *
 * Drives the price tabs and Shipping Rates tab in MBS Settings (lib/price-table-catalog.ts).
 * Saving goes through POST /admin/mbs/settings; applying through the
 * tier / group / owner apply routes with { table }.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const [levels, shipping] = await Promise.all([priceTableCatalog(req.scope), shippingCatalog(req.scope)])
  res.json({ levels, shipping })
}

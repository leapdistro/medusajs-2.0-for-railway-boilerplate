import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { priceTableCatalog } from "../../../../lib/price-table-catalog"

/**
 * GET /admin/mbs/price-tables
 *   → { levels: [{ level, label, tables: [{ key, categories, rows, unit?, value }] }] }
 *
 * Drives the price tabs in MBS Settings (lib/price-table-catalog.ts).
 * Saving goes through POST /admin/mbs/settings; applying through the
 * tier / group / owner apply routes with { table }.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.json({ levels: await priceTableCatalog(req.scope) })
}

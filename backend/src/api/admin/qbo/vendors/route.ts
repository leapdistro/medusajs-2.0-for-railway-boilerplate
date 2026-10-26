import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { listVendors } from "../../../../lib/qbo-api"
import { QBO_CONNECTION_MODULE } from "../../../../modules/qbo-connection"

/**
 * GET /admin/qbo/vendors
 * Active QBO vendors for receiving's supplier dropdown, read live (no
 * cache) so one just added in QBO is listed.
 *
 *   { connected: false }
 *   { connected: true, vendors: [{ id, displayName, email, phone, address }] }
 *   { connected: true, error }   when QBO couldn't be read
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)
  const [conn] = await qbo.listQboConnections({}, { take: 1 })
  if (!conn) return res.json({ connected: false })
  try {
    return res.json({ connected: true, vendors: await listVendors(qbo, conn) })
  } catch (e: any) {
    return res.json({ connected: true, error: e?.message ?? String(e) })
  }
}

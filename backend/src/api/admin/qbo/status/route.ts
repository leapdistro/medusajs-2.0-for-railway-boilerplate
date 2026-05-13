import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { QBO_CONNECTION_MODULE } from "../../../../modules/qbo-connection"

/**
 * GET /admin/qbo/status
 * Returns the current connection state for the admin UI to render.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)
  const rows = await qbo.listQboConnections({}, { take: 1 })
  const c = rows[0]
  if (!c) {
    return res.json({ connected: false })
  }
  return res.json({
    connected: true,
    realm_id: c.realm_id,
    environment: c.environment,
    company_name: c.company_name,
    last_bill_pushed_at: c.last_bill_pushed_at,
    last_bill_id: c.last_bill_id,
    refresh_expires_at: c.refresh_expires_at,
  })
}

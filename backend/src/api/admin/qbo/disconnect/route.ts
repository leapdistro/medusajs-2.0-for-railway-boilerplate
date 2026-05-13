import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { revokeToken } from "../../../../lib/qbo-oauth"
import { QBO_CONNECTION_MODULE } from "../../../../modules/qbo-connection"

/**
 * POST /admin/qbo/disconnect
 * Revokes the refresh token at Intuit (best-effort) and deletes the
 * QboConnection row. Operator must re-authorize to reconnect.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)

  const rows = await qbo.listQboConnections({}, { take: 1 })
  const c = rows[0]
  if (!c) {
    return res.json({ ok: true, message: "already disconnected" })
  }

  try {
    await revokeToken(c.refresh_token)
  } catch (e: any) {
    /* Non-fatal — local disconnect proceeds regardless. */
    logger.warn(`[qbo/disconnect] revoke failed: ${e?.message}`)
  }

  await qbo.deleteQboConnections([c.id])
  logger.info(`[qbo/disconnect] removed connection realm=${c.realm_id}`)
  return res.json({ ok: true })
}

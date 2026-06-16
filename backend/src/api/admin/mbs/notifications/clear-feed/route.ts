import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * POST /admin/mbs/notifications/clear-feed
 *
 * Hard-deletes every notification with channel = "feed" — wipes the
 * admin header bell drawer. Stock Medusa v2 dashboard auto-clears the
 * unread-badge on drawer open via a localStorage timestamp, but the
 * entries themselves stay in DB forever; this gives operators an
 * explicit nuke for once they've actioned everything.
 *
 * Hard delete is fine: feed-channel entries are operator-facing
 * informational pings — no downstream consumers, no audit value once
 * the operator has handled the underlying customer / order / push.
 * Email-channel entries (Resend deliveries) are NOT affected.
 *
 * Uses PG_CONNECTION raw SQL because Medusa's notification module
 * doesn't expose a bulk-delete by filter, and listing then deleting
 * one by one is wasteful for a clear-all operation.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const result = await knex.raw(`
      DELETE FROM notification
      WHERE channel = 'feed'
      RETURNING id
    `)
    const deleted = result?.rows?.length ?? 0
    logger.info(`[clear-feed-notifications] deleted ${deleted} feed notifications`)
    return res.json({ ok: true, deleted })
  } catch (e: any) {
    logger.error(`[clear-feed-notifications] ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Clear failed" })
  }
}

/**
 * GET /admin/mbs/notifications/clear-feed
 *
 * Lightweight count endpoint — the widget polls this on mount to
 * decide whether to render the button at all. Returns 0 on any error
 * so the widget stays hidden instead of showing a stale count.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const result = await knex.raw(`
      SELECT COUNT(*)::int AS count
      FROM notification
      WHERE channel = 'feed'
    `)
    const count = result?.rows?.[0]?.count ?? 0
    return res.json({ ok: true, count })
  } catch {
    return res.json({ ok: true, count: 0 })
  }
}

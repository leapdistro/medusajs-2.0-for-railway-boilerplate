import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * GET /admin/mbs/customers/pending-qbo-updates
 *
 * Lists customers with metadata.qbo_sync_pending = true. Powers the
 * "Pending QBO Updates" banner on the admin customer-list page so the
 * operator can see at a glance which buyers changed their profile
 * since the last push and click through to handle each.
 *
 * Implementation: raw jsonb filter on the customer table — Medusa v2's
 * query.graph doesn't support arbitrary metadata path predicates, and
 * the native /admin/customers endpoint doesn't expose a metadata
 * filter. Falls back to an empty list on any SQL error so the banner
 * silently disappears rather than blowing up the customer list page.
 *
 * Returns at most 50 — enough for the banner to be useful without
 * scrolling. If the list ever grows beyond that, batch-push from the
 * detail page is faster than scanning a long banner anyway.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const rows = await knex.raw(`
      SELECT id, email, first_name, last_name, company_name, metadata
      FROM customer
      WHERE metadata->>'qbo_sync_pending' = 'true'
        AND deleted_at IS NULL
      ORDER BY (metadata->>'qbo_sync_pending_at') ASC NULLS LAST
      LIMIT 50
    `)
    const list = (rows?.rows ?? []) as Array<{
      id: string
      email: string
      first_name: string | null
      last_name: string | null
      company_name: string | null
      metadata: Record<string, any> | null
    }>
    return res.json({
      ok: true,
      customers: list.map((c) => ({
        id: c.id,
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
        company_name: c.company_name,
        qbo_sync_pending_at: (c.metadata?.qbo_sync_pending_at as string | undefined) ?? null,
        qbo_customer_id: (c.metadata?.qbo_customer_id as string | undefined) ?? null,
      })),
    })
  } catch (e: any) {
    logger.warn(`[pending-qbo-updates] list failed: ${e?.message}`)
    return res.json({ ok: true, customers: [] })
  }
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { QBO_SYNC_MODULE } from "../../../../modules/qbo-sync"

/**
 * GET /admin/qbo/sync-jobs?status=failed
 * Queued order → QBO syncs, newest first, with the order's display id.
 * Used by the "Failed QuickBooks syncs" panel on the Orders list.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const status = String(req.query.status ?? "failed")
  const queue: any = req.scope.resolve(QBO_SYNC_MODULE)
  const jobs = await queue.listQboSyncJobs({ status }, { take: 100, order: { updated_at: "DESC" } })
  const ids = Array.from(new Set((jobs as any[]).map((j) => j.order_id)))
  const display = new Map<string, number>()
  if (ids.length) {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({ entity: "order", fields: ["id", "display_id"], filters: { id: ids } })
    for (const o of data as any[]) display.set(o.id, o.display_id)
  }
  res.json({
    jobs: (jobs as any[]).map((j) => ({
      id: j.id,
      order_id: j.order_id,
      display_id: display.get(j.order_id) ?? null,
      status: j.status,
      attempts: j.attempts,
      reasons: j.reasons,
      last_error: j.last_error,
      last_error_code: j.last_error_code,
      next_attempt_at: j.next_attempt_at,
      updated_at: j.updated_at,
    })),
  })
}

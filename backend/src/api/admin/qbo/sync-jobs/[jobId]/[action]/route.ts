import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { QBO_SYNC_MODULE } from "../../../../../../modules/qbo-sync"
import { runSyncJob } from "../../../../../../lib/qbo-sync-queue"
import { logOrderHistory } from "../../../../../../lib/order-history-log"

/**
 * POST /admin/qbo/sync-jobs/:jobId/retry    — run a failed sync again now
 * POST /admin/qbo/sync-jobs/:jobId/dismiss  — acknowledge, drop from the list
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { jobId, action } = req.params as { jobId: string; action: string }
  const queue: any = req.scope.resolve(QBO_SYNC_MODULE)
  const [job] = await queue.listQboSyncJobs({ id: jobId }, { take: 1 })
  if (!job) return res.status(404).json({ ok: false, error: `No sync job ${jobId}` })
  const adminId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id ?? null

  if (action === "dismiss") {
    await queue.updateQboSyncJobs({ id: job.id, status: "dismissed", finished_at: new Date() })
    await logOrderHistory(req.scope, job.order_id, {
      action: "qbo.sync_dismissed",
      summary: `Failed QuickBooks sync dismissed (${job.last_error_code ?? "error"})`,
      actor: { type: "admin", id: adminId },
    })
    return res.json({ ok: true })
  }

  if (action === "retry") {
    if (job.status !== "failed" && job.status !== "pending") {
      return res.status(409).json({ ok: false, error: `Job is ${job.status}` })
    }
    /* A manual retry gets a fresh set of attempts. */
    await queue.updateQboSyncJobs({ id: job.id, status: "pending", attempts: 0, next_attempt_at: new Date() })
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    const outcome = await runSyncJob(req.scope, job.id, {
      info: (m) => logger.info(m), warn: (m) => logger.warn(m), error: (m) => logger.error(m),
    })
    if (outcome?.ok === true) return res.json({ ok: true, message: outcome.message })
    return res.status(422).json({ ok: false, error: (outcome as any)?.error ?? "Sync failed" })
  }

  return res.status(400).json({ ok: false, error: `Unknown action ${action}` })
}

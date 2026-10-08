/**
 * Durable queue in front of syncOrderToQbo — no order change can silently
 * fail to reach QBO.
 *
 *   enqueueOrderSync()  saves a job first (coalescing: one pending job per
 *                       order — repeat changes just add their reason),
 *                       then the caller runs it straight away so the
 *                       operator still gets an immediate toast.
 *   runSyncJob()        one attempt. Success → done. A cause retrying can
 *                       fix (QBO down, token mid-refresh, lock held, a
 *                       crash) → retry after 1, 5, 15, 60 min. A cause it
 *                       can't (invoice settled, total mismatch, missing
 *                       item…) or retries exhausted → failed: History
 *                       entry, admin bell, and the failed-syncs list.
 *   runDueSyncJobs()    the every-minute job (jobs/qbo-sync-retry.ts):
 *                       resets jobs stuck "running" after a restart and
 *                       runs whatever is due.
 */
import { QBO_SYNC_MODULE } from "../modules/qbo-sync"
import { syncOrderToQbo, type SyncOutcome } from "./qbo-order-sync"
import { logOrderHistory } from "./order-history-log"
import { sendFeedNotification } from "./feed-notification"
import type { Logger } from "./qbo-order-push"

const RETRY_DELAYS_MIN = [1, 5, 15, 60]
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1
const STUCK_AFTER_MS = 10 * 60 * 1000

/** Failures a retry can't fix — surface immediately instead of retrying. */
const PERMANENT_CODES = new Set([
  "SETTLED", "BELOW_PAID", "VOIDED", "TOTAL_MISMATCH", "MISSING_ITEM", "NO_CUSTOMER",
])

type Job = {
  id: string
  order_id: string
  status: string
  attempts: number
  next_attempt_at: Date | string
  reasons: string
}

const svc = (scope: any): any => scope.resolve(QBO_SYNC_MODULE)

export async function enqueueOrderSync(scope: any, orderId: string, reason: string): Promise<Job> {
  const queue = svc(scope)
  const [pending] = await queue.listQboSyncJobs({ order_id: orderId, status: "pending" }, { take: 1 })
  if (pending) {
    const reasons = Array.from(new Set([...String(pending.reasons ?? "").split(",").filter(Boolean), reason])).join(",")
    return queue.updateQboSyncJobs({ id: pending.id, reasons, next_attempt_at: new Date() })
  }
  return queue.createQboSyncJobs({
    order_id: orderId,
    status: "pending",
    attempts: 0,
    next_attempt_at: new Date(),
    reasons: reason,
  })
}

/** One attempt at a job. Returns the sync outcome (null if another
 *  worker already took the job). */
export async function runSyncJob(scope: any, jobId: string, logger: Logger): Promise<SyncOutcome | null> {
  const queue = svc(scope)
  const [job] = (await queue.listQboSyncJobs({ id: jobId, status: "pending" }, { take: 1 })) as Job[]
  if (!job) return null
  await queue.updateQboSyncJobs({ id: job.id, status: "running", started_at: new Date() })

  const attempt = job.attempts + 1
  let outcome: SyncOutcome
  try {
    outcome = await syncOrderToQbo(scope, job.order_id, logger, { logFailures: false })
  } catch (e: any) {
    outcome = { ok: false, code: "EXCEPTION", error: e?.message ?? String(e) }
  }

  if (outcome.ok === true) {
    await queue.updateQboSyncJobs({
      id: job.id, status: "done", attempts: attempt, finished_at: new Date(),
      last_error: null, last_error_code: null,
    })
    return outcome
  }

  const failed = outcome as { code: string; error: string }
  const permanent = PERMANENT_CODES.has(failed.code)
  const exhausted = attempt >= MAX_ATTEMPTS
  if (!permanent && !exhausted) {
    const delayMin = RETRY_DELAYS_MIN[attempt - 1]
    await queue.updateQboSyncJobs({
      id: job.id, status: "pending", attempts: attempt,
      next_attempt_at: new Date(Date.now() + delayMin * 60_000),
      last_error: failed.error, last_error_code: failed.code,
    })
    await logOrderHistory(scope, job.order_id, {
      action: "qbo.sync_retry",
      summary: `QuickBooks sync failed (${failed.code}) — retrying in ${delayMin} min (attempt ${attempt} of ${MAX_ATTEMPTS})`,
      details: { code: failed.code, error: failed.error },
    })
    logger.warn(`[qbo-sync-queue] order ${job.order_id} attempt ${attempt} failed (${failed.code}); retry in ${delayMin}m`)
    return outcome
  }

  await queue.updateQboSyncJobs({
    id: job.id, status: "failed", attempts: attempt, finished_at: new Date(),
    last_error: failed.error, last_error_code: failed.code,
  })
  await logOrderHistory(scope, job.order_id, {
    action: "qbo.sync_failed",
    summary: `QuickBooks sync failed (${failed.code})${permanent ? "" : ` after ${attempt} attempts`}: ${failed.error}`,
    details: { code: failed.code, attempts: attempt },
  })
  await notifyFailure(scope, job.order_id, failed.code, failed.error)
  logger.warn(`[qbo-sync-queue] order ${job.order_id} sync FAILED (${failed.code}) after ${attempt} attempt(s)`)
  return outcome
}

/** Every-minute worker pass. */
export async function runDueSyncJobs(scope: any, logger: Logger): Promise<{ ran: number; reset: number }> {
  const queue = svc(scope)
  /* A restart mid-attempt leaves jobs "running" forever — put them back. */
  const running = (await queue.listQboSyncJobs({ status: "running" }, { take: 100 })) as Array<Job & { started_at?: string | Date | null }>
  let reset = 0
  for (const j of running) {
    if (!j.started_at || Date.now() - new Date(j.started_at).getTime() > STUCK_AFTER_MS) {
      await queue.updateQboSyncJobs({ id: j.id, status: "pending", next_attempt_at: new Date() })
      reset++
    }
  }
  const due = (await queue.listQboSyncJobs(
    { status: "pending", next_attempt_at: { $lte: new Date() } },
    { take: 20, order: { next_attempt_at: "ASC" } },
  )) as Job[]
  for (const j of due) await runSyncJob(scope, j.id, logger)
  return { ran: due.length, reset }
}

async function notifyFailure(scope: any, orderId: string, code: string, error: string): Promise<void> {
  let label = `${orderId.slice(0, 12)}…`
  try {
    const { Modules } = await import("@medusajs/framework/utils")
    const [order] = await scope.resolve(Modules.ORDER).listOrders({ id: [orderId] }, { take: 1 })
    if (order?.display_id != null) label = `#${order.display_id}`
    /* First-push failures keep stamping qbo_push_error, which the order
     * widget and its Retry Push button read. */
    if (order && !order.metadata?.qbo_invoice_id) {
      await scope.resolve(Modules.ORDER).updateOrders(order.id, {
        metadata: { ...(order.metadata ?? {}), qbo_push_error: error, qbo_push_error_at: new Date().toISOString() },
      })
    }
  } catch { /* best-effort */ }
  await sendFeedNotification(scope, {
    title: `QBO sync failed for order ${label}`,
    description:
      `Reason: ${code}\n${error.slice(0, 200)}\n` +
      `Open: /app/orders/${orderId} — or Orders → Failed QuickBooks syncs to retry.`,
  })
}

/** A manual sync succeeded: the order's waiting / failed jobs are moot. */
export async function resolveOrderJobs(scope: any, orderId: string): Promise<void> {
  const queue = svc(scope)
  const open = (await queue.listQboSyncJobs({ order_id: orderId, status: ["pending", "failed"] }, { take: 50 })) as Job[]
  for (const j of open) {
    await queue.updateQboSyncJobs({ id: j.id, status: "done", finished_at: new Date() })
  }
}

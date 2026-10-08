import { model } from "@medusajs/framework/utils"

/**
 * One queued "make this order's QBO invoice match the order" job
 * (lib/qbo-sync-queue.ts). Saved BEFORE anything is sent to QBO, so a
 * restart or a QBO outage can't lose an order change.
 *
 *   pending  → waiting for next_attempt_at
 *   running  → a worker has it (reset to pending if stuck > 10 min)
 *   done     → synced
 *   failed   → gave up (retries exhausted, or a cause retrying can't fix);
 *              listed in admin with Retry / Dismiss
 *   dismissed→ operator acknowledged a failure
 */
export const QboSyncJob = model.define("qbo_sync_job", {
  id: model.id({ prefix: "qsj" }).primaryKey(),
  order_id: model.text().index(),
  status: model.text(),
  attempts: model.number(),                 // attempts made so far
  next_attempt_at: model.dateTime(),
  reasons: model.text(),                    // comma-joined trigger events, coalesced
  last_error: model.text().nullable(),
  last_error_code: model.text().nullable(),
  started_at: model.dateTime().nullable(),
  finished_at: model.dateTime().nullable(),
})

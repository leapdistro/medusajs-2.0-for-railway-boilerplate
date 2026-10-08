import { model } from "@medusajs/framework/utils"

/**
 * One entry on an order's History timeline that Medusa doesn't record
 * itself: QBO sync outcomes, changes refused because the invoice is
 * settled, and (phase 3) QBO payments. Append-only — never updated or
 * deleted. Medusa's own records (order changes, fulfillments, returns,
 * payments) are read live and merged in by GET /admin/orders/:id/history.
 */
export const OrderHistoryEvent = model.define("order_history_event", {
  id: model.id({ prefix: "ohe" }).primaryKey(),
  order_id: model.text().index(),
  occurred_at: model.dateTime(),
  actor_type: model.text(),              // admin | customer | system | qbo
  actor_id: model.text().nullable(),     // admin user id when known
  action: model.text(),                  // e.g. qbo.invoice_updated, change_blocked
  summary: model.text(),                 // one-line, human readable
  details: model.json().nullable(),      // { before, after, invoice_id, ... }
})

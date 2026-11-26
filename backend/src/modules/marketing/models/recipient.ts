import { model } from "@medusajs/framework/utils"

/**
 * One row per customer per campaign, written when sending starts (the
 * audience is fixed at that moment). Sending works through the queued
 * rows, so a restart resumes where it stopped and nobody gets the same
 * campaign twice (unique campaign_id + email).
 *
 * status: queued → sent, or failed / skipped (suppressed since queuing).
 * Delivery events (opened, clicked, bounced) come later with the
 * Resend webhook (step 4).
 */
export const MarketingRecipient = model.define("marketing_recipient", {
  id: model.id({ prefix: "mrec" }).primaryKey(),
  campaign_id: model.text(),
  customer_id: model.text().nullable(),
  email: model.text(),
  status: model.text().default("queued"),
  message_id: model.text().nullable(),
  error: model.text().nullable(),
  sent_at: model.text().nullable(),
}).indexes([
  { on: ["campaign_id", "email"], unique: true },
  { on: ["campaign_id", "status"] },
])

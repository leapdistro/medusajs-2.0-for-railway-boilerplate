import { model } from "@medusajs/framework/utils"

/**
 * Addresses that must never get marketing email: unsubscribed, bounced,
 * marked as spam, or added by hand. Checked when recipients are queued
 * and again right before each batch is sent. Emails are stored
 * lower-cased. Transactional email (orders, account links) ignores it.
 */
export const MarketingSuppression = model.define("marketing_suppression", {
  id: model.id({ prefix: "msup" }).primaryKey(),
  email: model.text().unique(),
  reason: model.text(), // unsubscribed | bounced | complained | manual
  campaign_id: model.text().nullable(),
  note: model.text().nullable(),
})

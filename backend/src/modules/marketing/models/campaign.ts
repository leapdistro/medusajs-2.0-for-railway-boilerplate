import { model } from "@medusajs/framework/utils"

/**
 * One marketing email (Admin → Marketing). Content is a list of blocks
 * (lib/marketing/blocks.ts), never raw HTML, so every email renders
 * through the same on-brand components. `audience` is the filter the
 * admin picked; the actual recipients are written to marketing_recipient
 * when sending starts.
 *
 * status: draft → scheduled → sending → sent, or cancelled (a scheduled
 * one called off) / failed (sending stopped with an error).
 */
export const MarketingCampaign = model.define("marketing_campaign", {
  id: model.id({ prefix: "mcam" }).primaryKey(),
  name: model.text(),
  subject: model.text().default(""),
  preheader: model.text().default(""),
  blocks: model.json(),
  audience: model.json(),
  status: model.text().default("draft"),
  scheduled_at: model.text().nullable(), // ISO 8601
  started_at: model.text().nullable(),
  sent_at: model.text().nullable(),
  recipient_count: model.number().default(0),
  sent_count: model.number().default(0),
  failed_count: model.number().default(0),
  last_error: model.text().nullable(),
  /* Where the draft came from, e.g. { type: "receiving", id, invoice }. */
  source: model.json().nullable(),
  created_by: model.text().nullable(),
  last_test_at: model.text().nullable(),
  /* Send lock: the job that's sending holds it until this time. */
  locked_until: model.text().nullable(),
})

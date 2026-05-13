import { model } from "@medusajs/framework/utils"

/**
 * QboConnection — single-row table storing the active OAuth connection
 * to QuickBooks Online. One MBS deployment talks to one QBO company at
 * a time, so we expect 0 or 1 row to exist.
 *
 * Tokens land here after the operator clicks Connect and Intuit
 * redirects to our /admin/qbo/oauth/callback. Access tokens last ~1 hour
 * and are refreshed lazily before each API call using the refresh token
 * (good for ~100 days, sliding window).
 */
export const QboConnection = model.define("qbo_connection", {
  id: model.id().primaryKey(),
  realm_id: model.text(),                    // QBO company ID
  environment: model.text(),                 // "sandbox" | "production"
  access_token: model.text(),
  refresh_token: model.text(),
  access_expires_at: model.text(),           // ISO 8601
  refresh_expires_at: model.text(),          // ISO 8601
  company_name: model.text().nullable(),     // Cosmetic; filled after first API call
  last_bill_pushed_at: model.text().nullable(),
  last_bill_id: model.text().nullable(),     // QBO Bill ID for the most recent push
})

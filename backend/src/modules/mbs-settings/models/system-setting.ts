import { model } from "@medusajs/framework/utils"

/**
 * SystemSetting — single key-value table for everything operators edit
 * from admin (payment info, contact info, reason lists, etc.).
 *
 * `key` is a stable identifier consumer code looks up:
 *   - "payment_info"        → { dba, mailing_address, bank: { ... } }
 *   - "contact_info"        → { email, phone, hours }
 *   - "cancellation_reasons"→ Array<{ id, label, archived }>
 *   - "denial_reasons"      → Array<{ id, label, archived }>
 *
 * `value` is JSON — schema is per-key, validated/typed at the consumer
 * boundary (service helpers + admin widgets). Keeping the model generic
 * means new settings categories don't require migrations.
 *
 * `description` is admin-facing copy: shown above the editor so the
 * operator knows what the setting does.
 */
export const SystemSetting = model.define("system_setting", {
  id: model.id().primaryKey(),
  key: model.text().unique(),
  value: model.json(),
  description: model.text().nullable(),
})

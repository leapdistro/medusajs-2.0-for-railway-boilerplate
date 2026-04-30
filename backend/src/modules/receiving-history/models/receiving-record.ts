import { model } from "@medusajs/framework/utils"

/**
 * ReceivingRecord — audit trail for every successful receiving save.
 * One row per Save click (whether 1 line item or 50). Keeps the full
 * payload so we can reconstruct what happened, who paid what, and
 * which products / variants got created or restocked.
 *
 * Why json blobs vs normalized tables: receivings are append-only
 * audit events — we never query INTO them by line item. We just want
 * to render "JTK invoice INV1121, 29 lines, $40,525, 2026-04-29".
 * If the operational reporting need grows we can normalize later.
 *
 * `lineResults` per-row shape (from the save orchestrator):
 *   { strainName, qtyLb, qtyQps, action: "created"|"restocked",
 *     productId, inventoryItemId, landedPerQp, sellPrices: {qp,half,lb},
 *     coaUrl, error?: string }
 */
export const ReceivingRecord = model.define("receiving_record", {
  id: model.id().primaryKey(),
  invoice_number: model.text(),
  invoice_date: model.text(),                 // ISO 8601 — operator-editable so we keep as text
  supplier: model.json(),                     // { name, phone, email, address }
  shipping_total: model.text(),               // string for decimal safety (model.number is integer)
  invoice_total: model.text(),
  total_qps: model.number(),                  // integer — sum of all line quantities in QPs
  /* TODO(post-recovery): add computed_subtotal + computed_total via a
   * MANUAL ALTER migration (NOT db:generate — that's what nuked the
   * DB on 2026-04-29). For now the dual-totals UI sends them but the
   * save handler ignores them. */
  line_results: model.json(),                 // detailed per-row outcomes
  notes: model.text().nullable(),             // operator or AI notes
})

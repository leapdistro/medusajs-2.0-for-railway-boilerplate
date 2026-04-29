import { model } from "@medusajs/framework/utils"

/**
 * ReceivingDraft — operator's in-progress receiving review, persisted
 * so they can close the tab and resume later.
 *
 * `payload` is the full review state JSON: invoice + per-row dropdowns
 * (tier/type/best-for/effects). COA File objects are NOT persisted —
 * they're re-attached on resume, since File is not JSON-serializable
 * and uploading-on-pick would orphan files when drafts are abandoned.
 *
 * `summary` is denormalized so the drafts list view can render
 * supplier name, invoice #, line-item count, etc. without parsing the
 * full payload. Cheap to keep accurate (rewritten on every save).
 *
 * Soft-deletion via Medusa's standard `deleted_at` so accidental
 * deletes can be recovered; hard-deletes happen when the draft
 * promotes to a real receiving (Slice 2C).
 */
export const ReceivingDraft = model.define("receiving_draft", {
  id: model.id().primaryKey(),
  payload: model.json(),
  summary: model.json(),
})

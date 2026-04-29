import { MedusaService } from "@medusajs/framework/utils"
import { ReceivingDraft } from "./models/receiving-draft"

/**
 * ReceivingDrafts service. Inherits CRUD from MedusaService
 * (listReceivingDrafts, createReceivingDrafts, updateReceivingDrafts,
 * deleteReceivingDrafts, retrieveReceivingDraft) — no custom helpers
 * needed since the admin page handles the upsert/restore flow itself.
 */
class ReceivingDraftsModuleService extends MedusaService({
  ReceivingDraft,
}) {}

export default ReceivingDraftsModuleService

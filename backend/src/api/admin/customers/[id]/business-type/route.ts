import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../modules/mbs-settings"

/**
 * POST /admin/customers/:id/business-type { id: "smoke_shop" | "c_store" | ... }
 *
 * Sets the customer's business type AFTER initial application — the
 * apply form populates customer.metadata.business_type +
 * business_type_label at signup, but applicants sometimes need their
 * type corrected (typo, wrong selection, business pivots, etc.).
 *
 * Validates against the live `business_types` setting so the admin
 * can only assign currently-active types. Both id + label are stamped
 * onto metadata so downstream consumers (QBO Notes builder, etc.)
 * don't need to re-resolve the label per write.
 *
 * Passing `id: null` (or empty string) clears the type.
 */

type Row = { id: string; label: string; archived?: boolean }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const body = (req.body ?? {}) as { id?: string | null }
  const requestedId =
    typeof body.id === "string" && body.id.trim().length > 0
      ? body.id.trim()
      : null

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService
    .listCustomers({ id: [customerId] }, { take: 1 })
    .catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  let nextId: string | null = null
  let nextLabel: string | null = null

  if (requestedId) {
    /* Validate against the live setting. We allow archived rows to
     * stay assigned (so a customer set to "vape_shop" before the
     * type was archived doesn't get blocked from editing — admin
     * can still keep them on it deliberately) but reject ids that
     * never existed. */
    const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
    const rows = ((await settings.getSetting("business_types", [])) ?? []) as Row[]
    const match = rows.find((r) => r?.id === requestedId)
    if (!match) {
      return res.status(400).json({
        ok: false,
        message: `Unknown business type id "${requestedId}". Edit MBS Settings → Business Types to add it.`,
      })
    }
    nextId = match.id
    nextLabel = match.label
  }

  const meta = (customer.metadata ?? {}) as Record<string, any>
  const nextMeta = { ...meta }
  /* Use null (not delete) so Medusa v2's metadata merge stores the
   * null and downstream reads see the cleared state — same pattern
   * as pricing-mode / payment-terms / qbo_sync_pending. */
  nextMeta.business_type = nextId
  nextMeta.business_type_label = nextLabel

  try {
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })
  } catch (e: any) {
    logger.error(`[business-type] ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Update failed" })
  }

  logger.info(`[business-type] ${customer.email} → ${nextLabel ?? "(cleared)"}`)
  return res.json({ ok: true, business_type: nextId, business_type_label: nextLabel })
}

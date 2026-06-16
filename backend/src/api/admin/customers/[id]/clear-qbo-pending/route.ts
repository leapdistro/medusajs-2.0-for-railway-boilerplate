import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/customers/:id/clear-qbo-pending
 *
 * Discard the buyer's pending QBO-sync flag WITHOUT pushing anything
 * to QuickBooks. Used when the operator reviews the change in admin
 * and decides it's not worth a QBO update (typo, abandoned edit,
 * change irrelevant to QBO).
 *
 * Clears the same fields the push route clears on success, except
 * qbo_last_synced_at — which only makes sense to stamp when we
 * actually pushed. Leaving it untouched keeps the audit honest
 * ("last push was X, since then there were Y pending changes that
 * the operator dismissed").
 *
 * Returns 200 with the cleared customer even if the flag wasn't set —
 * makes the button idempotent so a double-click doesn't 404.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  const meta = (customer.metadata ?? {}) as Record<string, any>
  const nextMeta = { ...meta }
  nextMeta.qbo_sync_pending = false
  nextMeta.qbo_sync_pending_at = null
  /* Stamp qbo_pending_dismissed_at so we have an audit trail for
   * operator-dismissed edits — useful when debugging "why didn't this
   * land in QBO?" later. Stays out of UI by default; visible in raw
   * metadata. */
  nextMeta.qbo_pending_dismissed_at = new Date().toISOString()

  try {
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })
  } catch (e: any) {
    logger.error(`[clear-qbo-pending] ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Update failed" })
  }

  logger.info(`[clear-qbo-pending] ${customer.email} pending flag dismissed by operator`)
  return res.json({ ok: true })
}

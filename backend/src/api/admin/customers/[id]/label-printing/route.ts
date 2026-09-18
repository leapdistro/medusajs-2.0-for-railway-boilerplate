import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/customers/:id/label-printing { enabled: boolean }
 *
 * Sets (or clears) `customer.metadata.labels_enabled`. Read by the
 * storefront on every label surface:
 *   - true  → the buyer sees the per-weight print buttons on PDP + the
 *             COA library, and /labels/<slug>/<weight> renders
 *   - false / missing → buttons hidden, /labels 404s
 *
 * OFF by default, deliberately: label printing puts our brand + a COA QR
 * on someone else's retail shelf, so it's granted per account the same
 * way Net 15 is (see customer-payment-terms.tsx).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const body = (req.body ?? {}) as { enabled?: unknown }
  if (typeof body.enabled !== "boolean") {
    return res.status(400).json({ ok: false, message: "`enabled` must be true or false" })
  }
  const enabled = body.enabled

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const list = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => null)
  const customer = list?.[0]
  if (!customer) return res.status(404).json({ ok: false, message: "Customer not found" })

  /* Medusa v2's updateCustomers MERGES the metadata payload, so a
   * deleted key survives the write — write an explicit false instead of
   * removing it. Same trap the payment-terms route documents. */
  const nextMeta = { ...(customer.metadata ?? {}) } as Record<string, any>
  nextMeta.labels_enabled = enabled

  try {
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })
  } catch (e: any) {
    logger.error(`[label-printing] update failed for ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Update failed" })
  }

  logger.info(`[label-printing] ${customer.email} → ${enabled ? "enabled" : "disabled"}`)
  return res.json({ ok: true, labelsEnabled: enabled })
}

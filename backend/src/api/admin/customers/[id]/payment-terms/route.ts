import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/customers/:id/payment-terms { terms: "net15" | null }
 *
 * Sets (or clears) `customer.metadata.payment_terms`. Read at order
 * fulfillment time by the QBO push subscriber:
 *   - "net15"  → Invoice in QBO with SalesTermRef=Net 15, UNPAID (customer pays by check)
 *   - null/missing → Invoice + Payment in QBO, marked PAID (KAJA charged at checkout)
 *
 * Also gates the storefront checkout (Phase 4 work): when terms === "net15",
 * skip the KAJA card form and show "Pay by check (Net 15)" instead.
 */

const VALID_TERMS = ["net15"] as const

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const body = (req.body ?? {}) as { terms?: string | null }
  const requestedRaw = body.terms == null ? null : String(body.terms).trim().toLowerCase()
  const requested =
    !requestedRaw || requestedRaw === "default" || requestedRaw === ""
      ? null
      : (VALID_TERMS as readonly string[]).includes(requestedRaw)
        ? requestedRaw
        : "__INVALID__"
  if (requested === "__INVALID__") {
    return res.status(400).json({
      ok: false,
      message: `Invalid terms. Allowed: ${VALID_TERMS.join(", ")} or null/default.`,
    })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const list = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => null)
  const customer = list?.[0]
  if (!customer) return res.status(404).json({ ok: false, message: "Customer not found" })

  /* Medusa v2's updateCustomers MERGES the metadata payload rather than
   * replacing it — `delete nextMeta.payment_terms` produces a JSON
   * object without the key, but the merge leaves the existing DB key
   * untouched. Explicit `null` works (the merge stores the null and
   * downstream comparisons against "net15" correctly return false).
   * Found 2026-05-17 when the toggle UI reported success but never
   * flipped because the metadata still read "net15" on refetch. */
  const nextMeta = { ...(customer.metadata ?? {}) } as Record<string, any>
  nextMeta.payment_terms = requested

  try {
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })
  } catch (e: any) {
    logger.error(`[payment-terms] update failed for ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: e?.message ?? "Update failed" })
  }

  logger.info(`[payment-terms] ${customer.email} → ${requested ?? "default"}`)
  return res.json({ ok: true, paymentTerms: requested })
}

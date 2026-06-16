import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { pushCustomerToQbo } from "../../../../../lib/customer-to-qbo"

/**
 * POST /admin/customers/:id/retry-qbo-push
 *
 * Operator-initiated retry of the QBO Customer push WITHOUT triggering
 * another welcome email. Sister to the approve-and-welcome route — same
 * push lib (`lib/customer-to-qbo.ts`), but skips the group sync + reset-
 * password steps.
 *
 * Use case: approve-and-welcome stamped customer.metadata.qbo_push_error
 * because the QBO API rejected the create (duplicate name, missing
 * permission, etc.). Operator fixes the underlying issue in QBO
 * (matches email on existing record, deletes the inactive duplicate,
 * etc.) and clicks "Retry QBO Push" in the customer-detail widget.
 *
 * The push lib is idempotent and self-clears qbo_push_error on success,
 * so re-running this route safely converges.
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

  const outcome = await pushCustomerToQbo(req.scope, customer, {
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
  }).catch((e) => ({ state: "error" as const, message: e?.message ?? String(e) }))

  if (outcome.state === "synced") {
    return res.json({
      ok: true,
      qboCustomerId: outcome.qboCustomerId,
      created: outcome.created,
    })
  }
  if (outcome.state === "skipped") {
    return res.status(400).json({ ok: false, message: outcome.reason })
  }
  /* error */
  return res.status(502).json({ ok: false, message: outcome.message })
}

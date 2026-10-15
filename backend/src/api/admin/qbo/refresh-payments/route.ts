import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refreshOrderPayment } from "../../../../lib/qbo-inbound"

/**
 * POST /admin/qbo/refresh-payments
 *
 * Re-check QBO payment status for every order whose invoice isn't yet
 * recorded as paid or voided. Catch-up for payments whose webhook never
 * arrived. One invoice read per order, sequential, to stay well inside
 * QBO's rate limit.
 *
 * Returns the orders whose status changed, so the operator sees what
 * moved.
 */
/* A run takes minutes and the in-flight lock TTL is 60s, so a second
 * click (or a browser retry) is turned away with this process-level
 * flag. Per-order marking has its own lock in qbo-inbound, which is
 * what keeps payments from being recorded twice. */
let running = false

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (running) {
    return res.status(409).json({ ok: false, message: "A payment check is already running — wait for it to finish" })
  }
  running = true
  try {
    return await run(req, res)
  } finally {
    running = false
  }
}

async function run(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const pg: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  const { rows } = await pg.raw(
    `select id, display_id, metadata->>'qbo_payment_status' as status
       from "order"
      where deleted_at is null
        and canceled_at is null
        and metadata->>'qbo_invoice_id' is not null
        and coalesce(metadata->>'qbo_payment_status', '') not in ('paid', 'voided')
      order by display_id`,
  )

  const changed: Array<{ display_id: number; from: string | null; to: string | null; paid: number; balance: number }> = []
  const failed: Array<{ display_id: number; error: string }> = []
  for (const r of rows as Array<{ id: string; display_id: number; status: string | null }>) {
    try {
      const out = await refreshOrderPayment(req.scope, r.id, logger)
      if ((out.status ?? null) !== (r.status ?? null)) {
        changed.push({ display_id: r.display_id, from: r.status, to: out.status, paid: out.paid, balance: out.balance })
      }
    } catch (e: any) {
      failed.push({ display_id: r.display_id, error: e?.message ?? "error" })
    }
  }

  logger.info(`[qbo-refresh-payments] checked ${rows.length}, changed ${changed.length}, failed ${failed.length}`)
  return res.json({ ok: true, checked: rows.length, changed, failed })
}

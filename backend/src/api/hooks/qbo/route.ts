import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { parseQboNotification, processQboEntity, verifyIntuitSignature } from "../../../lib/qbo-inbound"
import { getIdempotentResponse, setIdempotentResponse } from "../../../lib/idempotency"

/**
 * POST /hooks/qbo — QuickBooks change notifications (Invoice, Payment,
 * CreditMemo, RefundReceipt), configured in the Intuit developer portal.
 *
 * Verifies `intuit-signature` (HMAC-SHA256 of the raw body with
 * QBO_WEBHOOK_VERIFIER_TOKEN), answers 200 at once — Intuit expects a
 * fast reply and retries otherwise — then processes each entity in the
 * background (lib/qbo-inbound.ts). Notifications repeat; each entity
 * change is processed once (Redis, 24h).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const token = process.env.QBO_WEBHOOK_VERIFIER_TOKEN ?? ""
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody
  const signature = String(req.headers["intuit-signature"] ?? "")

  if (!token) {
    logger.error("[hooks/qbo] QBO_WEBHOOK_VERIFIER_TOKEN not set — rejecting")
    return res.status(503).json({ ok: false })
  }
  if (!raw || !verifyIntuitSignature(raw, signature, token)) {
    logger.warn("[hooks/qbo] bad or missing intuit-signature — rejected")
    return res.status(401).json({ ok: false })
  }

  let body: any
  try { body = JSON.parse(raw.toString("utf8")) } catch { body = req.body }
  const refs = parseQboNotification(body)
  res.status(200).json({ ok: true, received: refs.length })

  const log = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m), error: (m: string) => logger.error(m) }
  setImmediate(async () => {
    for (const ref of refs) {
      try {
        if (await getIdempotentResponse("qbo-webhook", ref.key)) continue
        await processQboEntity(req.scope, ref, log)
        await setIdempotentResponse("qbo-webhook", ref.key, 200, { done: true })
      } catch (e: any) {
        logger.warn(`[hooks/qbo] ${ref.name} ${ref.id} failed: ${e?.message}`)
      }
    }
    if (refs.length) logger.info(`[hooks/qbo] processed ${refs.length} change(s): ${refs.map((r) => `${r.name} ${r.id} ${r.operation}`).join(", ")}`)
  })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createHash, timingSafeEqual } from "crypto"
import { sendFeedNotification } from "../../../../../lib/feed-notification"

/**
 * POST /store/mbs/applications/extras
 * Body: { customerId, token, heard?, message? }
 *
 * The optional "Help us out" card on the signup thank-you screen:
 * "How did you hear about us?" and "Anything else?" are asked after the
 * application is in. The application response hands the browser a
 * one-time token (its hash is on the customer's metadata, 24h); this
 * route checks it, saves the answers on the same metadata keys the form
 * used before (`heard`, `message`) and spends the token.
 */

function pickStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : ""
}

function sameHash(token: string, hash: unknown): boolean {
  if (typeof hash !== "string" || !token) return false
  const a = Buffer.from(createHash("sha256").update(token).digest("hex"))
  const b = Buffer.from(hash)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const body = (req.body ?? {}) as Record<string, unknown>
  const customerId = pickStr(body.customerId, 64)
  const token = pickStr(body.token, 128)
  const heard = pickStr(body.heard, 40)
  const message = pickStr(body.message, 2000)

  if (!customerId || !token) return res.status(400).json({ ok: false, message: "Missing token" })
  if (!heard && !message) return res.json({ ok: true })

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  let customer: { id: string; email: string; company_name?: string | null; metadata?: Record<string, any> | null } | null = null
  try {
    customer = await customerService.retrieveCustomer(customerId)
  } catch {
    customer = null
  }
  const meta = customer?.metadata ?? {}
  const expires = Date.parse(String(meta.extras_token_expires_at ?? ""))
  if (!customer || !sameHash(token, meta.extras_token_hash) || !(expires > Date.now())) {
    return res.status(403).json({ ok: false, message: "This link has expired. Email wholesale@hempmbs.com instead." })
  }

  await customerService.updateCustomers(customer.id, {
    metadata: {
      ...meta,
      ...(heard ? { heard } : {}),
      ...(message ? { message } : {}),
      extras_token_hash: null,
      extras_token_expires_at: null,
    },
  })
  logger.info(`[/store/mbs/applications/extras] saved for customer ${customer.id}`)

  const name = customer.company_name || meta.business_name || customer.email
  await sendFeedNotification(req.scope, {
    title: `More from ${name}`,
    description:
      (heard ? `Heard about us: ${heard}\n` : "") +
      (message ? `${message.slice(0, 300)}\n` : "") +
      `Open: /app/customers/${customer.id}`,
  })

  return res.json({ ok: true })
}

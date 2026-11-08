import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { extractCertificate, isReadableCertificateType } from "../../../../../lib/ai-certificate-extraction"
import { takeUsage } from "../../../../../lib/usage-cap"

/**
 * POST /store/mbs/applications/read-certificate
 *
 * Signup step 3: the applicant uploads their resale certificate and we
 * read the licence number and business name off it. Nothing is stored;
 * the file is sent again with the application.
 *
 * Public (publishable key, like the rest of /store/mbs/*), so each call
 * is capped: per applicant IP (forwarded by the storefront proxy) and a
 * global daily ceiling that bounds the Anthropic bill. Every failure is
 * `{ ok: false }` with status 200 — the form falls back to typing.
 */

type UploadedFile = { originalname: string; mimetype: string; size: number; buffer: Buffer }

const PER_IP_PER_HOUR = 8
const GLOBAL_PER_DAY = 300

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const file = ((req as unknown as { files?: Record<string, UploadedFile[]> }).files ?? {}).file?.[0]

  if (!file) return res.status(400).json({ ok: false, message: "No file" })
  if (!isReadableCertificateType(file.mimetype)) return res.json({ ok: false, reason: "unsupported_type" })

  const ip = (req.get("x-mbs-client-ip") || req.ip || "anon").slice(0, 64)
  const allowed = await takeUsage([
    { key: `cert-read:ip:${ip}`, limit: PER_IP_PER_HOUR, seconds: 3600 },
    { key: "cert-read:all", limit: GLOBAL_PER_DAY, seconds: 86400 },
  ])
  if (!allowed) {
    logger.warn(`[read-certificate] cap reached (ip ${ip})`)
    return res.json({ ok: false, reason: "busy" })
  }

  const result = await extractCertificate(file.buffer, file.mimetype)
  if ("error" in result) {
    logger.warn(`[read-certificate] could not read ${file.mimetype} ${Math.round(file.size / 1024)}KB: ${result.error}`)
    return res.json({ ok: false, reason: "unreadable" })
  }

  logger.info(
    `[read-certificate] read ${file.mimetype} ${Math.round(file.size / 1024)}KB ` +
    `(${result.inputTokens} in / ${result.outputTokens} out, confident=${result.data.confident})`,
  )
  return res.json({ ok: true, ...result.data })
}

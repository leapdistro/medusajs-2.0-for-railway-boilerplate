import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { randomBytes } from "crypto"

/**
 * Wholesale-application submission endpoint (public, gated by publishable
 * API key like the rest of /store/mbs/*).
 *
 * Flow:
 *   1. Validate required fields (text + 2 files)
 *   2. Upload EIN doc + Resale Certificate to Bucket via the file service
 *   3. Register Medusa auth identity for the email with a secure random
 *      password (never returned, never logged) — this lets the applicant
 *      use Medusa's standard /auth/customer/emailpass/reset-password flow
 *      later to set their actual password
 *   4. POST /store/customers with the auth token → creates a Customer
 *      record LINKED to that auth identity, with all our metadata
 *   5. Conditionally send Resend emails (only if RESEND_API_KEY +
 *      RESEND_FROM_EMAIL set — gracefully no-ops otherwise)
 *
 * Multer middleware in src/api/middlewares.ts parses the multipart payload
 * — files arrive on `req.files`, text fields on `req.body`.
 */

type UploadedFile = {
  fieldname: string
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

const NOTIFICATION_TO = "wholesale@hempmbs.com"

function pickStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

/** Generate a high-entropy random password. The applicant never sees this —
 *  it's only here so Medusa has SOMETHING to hash for the auth identity.
 *  Approved applicants reset to their own password via /auth/forgot. */
function generateRandomPassword(): string {
  return randomBytes(32).toString("base64url")
}

/** Resolve the publicly-reachable URL of THIS server. The auth + customer
 *  endpoints are HTTP — even when called from inside the same Medusa
 *  process, going via HTTP is the simplest way to use the publishable-key
 *  validated paths. Falls back to localhost in dev. */
function backendBaseUrl(req: MedusaRequest): string {
  const fromEnv = process.env.BACKEND_PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN_VALUE
  if (fromEnv) return fromEnv.startsWith("http") ? fromEnv : `https://${fromEnv}`
  // Derive from the incoming request as a last resort
  const host = req.get?.("host") ?? "localhost:9000"
  const proto = req.protocol ?? (host.includes("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  // Multer fills req.files as { fieldname: File[] } when using .fields()
  const files = (req as unknown as { files?: Record<string, UploadedFile[]> }).files ?? {}
  const einDoc     = files.einDoc?.[0]
  const licenseDoc = files.licenseDoc?.[0]

  // ─── Validate text fields ──────────────────────────────────────────
  const body = req.body as Record<string, unknown>
  const businessName = pickStr(body.businessName)
  const contactName  = pickStr(body.contactName)
  const email        = pickStr(body.email).toLowerCase()
  const phone        = pickStr(body.phone)
  const address1     = pickStr(body.address1)
  const address2     = pickStr(body.address2)
  const city         = pickStr(body.city)
  const state        = pickStr(body.state)
  const zip          = pickStr(body.zip)
  const country      = pickStr(body.country) || "US"
  const ein          = pickStr(body.ein)
  const license      = pickStr(body.license)
  const website      = pickStr(body.website)
  const volume       = pickStr(body.volume)
  const heard        = pickStr(body.heard)
  const message      = pickStr(body.message)

  const required: { name: string; value: string }[] = [
    { name: "Business name",     value: businessName },
    { name: "Contact name",      value: contactName },
    { name: "Email",             value: email },
    { name: "Phone",             value: phone },
    { name: "Address",           value: address1 },
    { name: "City",              value: city },
    { name: "State",             value: state },
    { name: "ZIP",               value: zip },
    { name: "EIN",               value: ein },
    { name: "License",           value: license },
    { name: "Volume",            value: volume },
  ]
  const missing = required.filter((r) => !r.value).map((r) => r.name)
  if (missing.length > 0) {
    return res.status(400).json({ ok: false, message: `Missing required: ${missing.join(", ")}` })
  }
  if (!isEmail(email)) {
    return res.status(400).json({ ok: false, message: "Email format invalid" })
  }
  if (!einDoc)     return res.status(400).json({ ok: false, message: "EIN document is required" })
  if (!licenseDoc) return res.status(400).json({ ok: false, message: "Resale certificate is required" })

  // ─── Upload files to Bucket ──────────────────────────────────────────
  const fileService: any = req.scope.resolve(Modules.FILE)
  const ts = Date.now()
  const safeBiz = businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)

  const uploadOne = async (f: UploadedFile, suffix: string) => {
    const ext = f.originalname.includes(".") ? f.originalname.split(".").pop() : "bin"
    const filename = `applications/${ts}-${safeBiz}-${suffix}.${ext}`
    const [created] = await fileService.createFiles([{
      filename,
      mimeType: f.mimetype,
      content: f.buffer.toString("base64"),
    }])
    return created?.url as string | undefined
  }

  let einDocUrl: string | undefined
  let licenseDocUrl: string | undefined
  try {
    einDocUrl     = await uploadOne(einDoc, "ein")
    licenseDocUrl = await uploadOne(licenseDoc, "license")
  } catch (e: any) {
    logger.error(`[/store/mbs/applications] file upload failed: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "File upload failed. Please try again or email " + NOTIFICATION_TO })
  }

  // ─── Register Medusa auth identity (with secure random password) ────
  const baseUrl = backendBaseUrl(req)
  const publishableKey = req.get("x-publishable-api-key") || ""
  const tempPassword = generateRandomPassword()

  let authToken: string | undefined
  let duplicateEmail = false
  try {
    const registerRes = await fetch(`${baseUrl}/auth/customer/emailpass/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": publishableKey,
      },
      body: JSON.stringify({ email, password: tempPassword }),
    })
    if (registerRes.ok) {
      const registerJson = await registerRes.json() as { token?: string }
      authToken = registerJson.token
    } else {
      const body = await registerRes.text().catch(() => "")
      // Most common: email already in use → applicant has applied before
      if (registerRes.status === 401 || registerRes.status === 400 || body.toLowerCase().includes("already")) {
        duplicateEmail = true
        logger.warn(`[/store/mbs/applications] duplicate email at auth register: ${email}`)
      } else {
        logger.error(`[/store/mbs/applications] auth register failed: ${registerRes.status} ${body.slice(0, 200)}`)
        return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
      }
    }
  } catch (e: any) {
    logger.error(`[/store/mbs/applications] auth register threw: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
  }

  // ─── Create the linked Customer (skips on duplicate — original record stands) ──
  let customerId: string | undefined
  if (authToken) {
    try {
      const customerRes = await fetch(`${baseUrl}/store/customers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-publishable-api-key": publishableKey,
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          email,
          first_name: contactName.split(" ")[0] || contactName,
          last_name:  contactName.split(" ").slice(1).join(" ") || null,
          company_name: businessName,
          phone,
          metadata: {
            application_status: "pending_review",
            applied_at: new Date().toISOString(),
            business_name: businessName,
            ein,
            license,
            address_line1: address1,
            address_line2: address2,
            city,
            state,
            zip,
            country,
            website,
            volume,
            heard,
            message,
            ein_doc_url: einDocUrl,
            license_doc_url: licenseDocUrl,
          },
        }),
      })
      if (customerRes.ok) {
        const customerJson = await customerRes.json() as { customer?: { id?: string } }
        customerId = customerJson.customer?.id
      } else {
        const body = await customerRes.text().catch(() => "")
        logger.error(`[/store/mbs/applications] customer create failed: ${customerRes.status} ${body.slice(0, 200)}`)
        return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
      }
    } catch (e: any) {
      logger.error(`[/store/mbs/applications] customer create threw: ${e?.message}`)
      return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
    }
  }

  // ─── Conditionally send Resend emails ──────────────────────────────
  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  const emailsEnabled = !!(resendKey && resendFrom)

  if (emailsEnabled) {
    try {
      const notificationService: any = req.scope.resolve(Modules.NOTIFICATION)
      await notificationService.createNotifications([{
        to: NOTIFICATION_TO,
        channel: "email",
        template: "wholesale-application-team",
        from: resendFrom,
        data: {
          subject: `New wholesale application: ${businessName}`,
          businessName, contactName, email, phone,
          address: `${address1}${address2 ? `, ${address2}` : ""}, ${city}, ${state} ${zip}`,
          ein, license, website, volume, heard, message,
          einDocUrl, licenseDocUrl,
          customerId,
        },
      }])
      await notificationService.createNotifications([{
        to: email,
        channel: "email",
        template: "wholesale-application-applicant",
        from: resendFrom,
        data: {
          subject: "Your Mind Body Spirit wholesale application",
          contactName,
          businessName,
        },
      }])
    } catch (e: any) {
      logger.warn(`[/store/mbs/applications] email send failed (non-fatal): ${e?.message}`)
    }
  } else {
    logger.info(
      `[/store/mbs/applications] emails skipped — RESEND_API_KEY/RESEND_FROM_EMAIL not set. New application from ${businessName} (${email}). Customer: ${customerId ?? "(duplicate)"}.`
    )
  }

  return res.json({ ok: true, customerId, duplicate: duplicateEmail })
}

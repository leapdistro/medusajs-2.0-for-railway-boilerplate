import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { randomBytes } from "crypto"

/**
 * Wholesale-application submission endpoint (public, gated by publishable
 * API key like the rest of /store/mbs/*).
 *
 * Flow:
 *   1. Validate text + 2 file fields
 *   2. Look up existing customer by email — duplicate-application logic
 *      runs FIRST so we don't waste storage / send misleading emails on
 *      reject paths:
 *        - approved      → 409 (sign in instead)
 *        - pending_review→ 409 (we already have it)
 *        - denied        → re-application (allowed; updates existing record)
 *        - none / new    → fresh submission
 *   3. Upload EIN doc + Resale Certificate (only if not rejected above)
 *   4. New: register Medusa auth identity + create Customer
 *      Re-application: update existing customer's metadata + reset to
 *        pending_review + clear denial state. Auth identity already
 *        exists — no register call needed.
 *   5. Send applicant + team emails (team email gets isReapplication
 *      banner so the operator can spot resubmissions)
 *
 * Multer middleware in src/api/middlewares.ts parses multipart — files
 * arrive on `req.files`, text fields on `req.body`.
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

/** Resolve the publicly-reachable URL of THIS server. */
function backendBaseUrl(req: MedusaRequest): string {
  const fromEnv = process.env.BACKEND_PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN_VALUE
  if (fromEnv) return fromEnv.startsWith("http") ? fromEnv : `https://${fromEnv}`
  const host = req.get?.("host") ?? "localhost:9000"
  const proto = req.protocol ?? (host.includes("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const files = (req as unknown as { files?: Record<string, UploadedFile[]> }).files ?? {}
  const einDoc     = files.einDoc?.[0]
  const licenseDoc = files.licenseDoc?.[0]

  // ─── (1) Validate text fields ──────────────────────────────────────
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

  // ─── (2) Customer lookup BEFORE side effects ───────────────────────
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)

  let existingCustomer: { id: string; email: string; metadata?: Record<string, any> | null } | null = null
  try {
    const list = await customerService.listCustomers({ email: [email] }, { take: 1 })
    existingCustomer = list?.[0] ?? null
  } catch (e: any) {
    logger.warn(`[/store/mbs/applications] customer lookup failed (continuing): ${e?.message}`)
  }

  let isReapplication = false
  let previousDenialReason: string | null = null

  if (existingCustomer) {
    const meta = existingCustomer.metadata ?? {}
    const prevStatus = typeof meta.application_status === "string" ? meta.application_status : null

    if (prevStatus === "approved") {
      logger.info(`[/store/mbs/applications] reject: already approved (${email})`)
      return res.status(409).json({
        ok: false,
        code: "ALREADY_APPROVED",
        message: `${email} already has a wholesale account. Sign in to start ordering, or use a different email if this is for a separate business.`,
      })
    }
    if (prevStatus === "pending_review") {
      logger.info(`[/store/mbs/applications] reject: already pending (${email})`)
      return res.status(409).json({
        ok: false,
        code: "ALREADY_PENDING",
        message: `We already have a wholesale application from ${email} under review. Give us one business day — we'll be in touch soon.`,
      })
    }
    // prevStatus === "denied" or null/undefined → allow as re-application
    isReapplication = true
    if (prevStatus === "denied" && typeof meta.denial_reason_label === "string") {
      previousDenialReason = meta.denial_reason_label
    }
  }

  // ─── (3) Upload files (only after the duplicate gate cleared) ───────
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

  // ─── (4) Either update existing (re-application) or register new ────
  let customerId: string | undefined

  if (isReapplication && existingCustomer) {
    /* Re-application path: customer + auth identity already exist.
     * Update the customer's metadata in-place — overwrite application
     * fields with the latest submission, reset status to pending_review,
     * and CLEAR denial state (operator will re-deny via the widget if
     * the issue still isn't addressed). */
    try {
      await customerService.updateCustomers(existingCustomer.id, {
        first_name: contactName.split(" ")[0] || contactName,
        last_name:  contactName.split(" ").slice(1).join(" ") || null,
        company_name: businessName,
        phone,
        metadata: {
          ...(existingCustomer.metadata ?? {}),
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
          // Clear prior denial state — clean slate for review
          denied_at: null,
          denial_reason_id: null,
          denial_reason_label: null,
          denial_operator_note: null,
        },
      })
      customerId = existingCustomer.id
      logger.info(`[/store/mbs/applications] re-application accepted for ${email} (customer ${customerId})`)
    } catch (e: any) {
      logger.error(`[/store/mbs/applications] re-application update failed: ${e?.message}`)
      return res.status(500).json({ ok: false, message: "Could not save re-application. Please email " + NOTIFICATION_TO })
    }
  } else {
    /* Fresh submission path: register auth identity then create customer. */
    const baseUrl = backendBaseUrl(req)
    const publishableKey = req.get("x-publishable-api-key") || ""
    const tempPassword = generateRandomPassword()

    let authToken: string | undefined
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
        /* Edge case: customer lookup found nothing but auth identity DOES
         * exist (orphan auth row). Treat it like ALREADY_APPROVED — safer
         * to point them to sign-in than to silently fail. */
        if (registerRes.status === 401 || registerRes.status === 400 || body.toLowerCase().includes("already")) {
          logger.warn(`[/store/mbs/applications] orphan auth identity for ${email} (no customer record)`)
          return res.status(409).json({
            ok: false,
            code: "ALREADY_APPROVED",
            message: `${email} appears to already have an account. Try signing in (or use the password reset link), or use a different email.`,
          })
        }
        logger.error(`[/store/mbs/applications] auth register failed: ${registerRes.status} ${body.slice(0, 200)}`)
        return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
      }
    } catch (e: any) {
      logger.error(`[/store/mbs/applications] auth register threw: ${e?.message}`)
      return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
    }

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
  }

  // ─── (5) Send Resend emails (best-effort) ───────────────────────────
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
          emailOptions: {
            subject: isReapplication
              ? `Re-application: ${businessName}`
              : `New wholesale application: ${businessName}`,
          },
          businessName, contactName, email, phone,
          address: `${address1}${address2 ? `, ${address2}` : ""}, ${city}, ${state} ${zip}`,
          ein, license, website, volume, heard, message,
          einDocUrl, licenseDocUrl,
          customerId,
          isReapplication,
          previousDenialReason,
        },
      }])
      await notificationService.createNotifications([{
        to: email,
        channel: "email",
        template: "wholesale-application-applicant",
        from: resendFrom,
        data: {
          emailOptions: {
            subject: isReapplication
              ? "We received your updated wholesale application"
              : "Your Mind Body Spirit wholesale application",
          },
          contactName,
          businessName,
        },
      }])
    } catch (e: any) {
      logger.warn(`[/store/mbs/applications] email send failed (non-fatal): ${e?.message}`)
    }
  } else {
    logger.info(
      `[/store/mbs/applications] emails skipped — RESEND_API_KEY/RESEND_FROM_EMAIL not set. ${isReapplication ? "Re-application" : "New application"} from ${businessName} (${email}). Customer: ${customerId ?? "(unknown)"}.`
    )
  }

  return res.json({
    ok: true,
    customerId,
    isReapplication,
  })
}

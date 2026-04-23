import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Wholesale-application submission endpoint (public, gated by publishable
 * API key like the rest of /store/mbs/*).
 *
 * Flow:
 *   1. Validate required fields (text + 2 files)
 *   2. Upload EIN doc + Resale Certificate to Bucket via the file service
 *   3. Create a pending Customer in Medusa with metadata that includes
 *      everything reviewers need: business info, EIN, license, doc URLs,
 *      timestamps, lead source
 *   4. CONDITIONALLY send two emails via Resend (only if RESEND_API_KEY +
 *      RESEND_FROM_EMAIL env vars are set — gracefully no-ops otherwise so
 *      apps still flow through pre-launch). Notification → MBS team.
 *      Confirmation → applicant.
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

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  // Multer fills req.files as { fieldname: File[] } when using .fields()
  const files = (req as unknown as { files?: Record<string, UploadedFile[]> }).files ?? {}
  const einDoc     = files.einDoc?.[0]
  const licenseDoc = files.licenseDoc?.[0]

  // ─── Validate text fields ──────────────────────────────────────────
  const body = req.body as Record<string, unknown>
  const businessName = pickStr(body.businessName)
  const contactName  = pickStr(body.contactName)
  const email        = pickStr(body.email)
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
    // Medusa file service createFiles signature: ({ filename, mimeType, content })
    // content is base64-encoded string
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
    req.scope.resolve(ContainerRegistrationKeys.LOGGER).error(`[/store/mbs/applications] file upload failed: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "File upload failed. Please try again or email " + NOTIFICATION_TO })
  }

  // ─── Create pending Customer in Medusa ──────────────────────────────
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  let customerId: string | undefined
  try {
    const [customer] = await customerService.createCustomers([{
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
    }])
    customerId = customer?.id
  } catch (e: any) {
    // Most common: email already in use (someone applied twice). We treat
    // this as success at the API layer — the original record stays + reviewer
    // can de-dupe — but we log so we can monitor.
    const msg = String(e?.message ?? "")
    if (msg.toLowerCase().includes("already exists") || msg.toLowerCase().includes("duplicate")) {
      req.scope.resolve(ContainerRegistrationKeys.LOGGER).warn(`[/store/mbs/applications] duplicate email: ${email}`)
    } else {
      req.scope.resolve(ContainerRegistrationKeys.LOGGER).error(`[/store/mbs/applications] customer create failed: ${msg}`)
      return res.status(500).json({ ok: false, message: "Could not save application. Please email " + NOTIFICATION_TO })
    }
  }

  // ─── Conditionally send emails ──────────────────────────────────────
  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  const emailsEnabled = !!(resendKey && resendFrom)

  if (emailsEnabled) {
    try {
      const notificationService: any = req.scope.resolve(Modules.NOTIFICATION)

      // Notification to MBS team
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

      // Confirmation to applicant
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
      // Don't fail the request — application is saved either way
      req.scope.resolve(ContainerRegistrationKeys.LOGGER).warn(`[/store/mbs/applications] email send failed (non-fatal): ${e?.message}`)
    }
  } else {
    req.scope.resolve(ContainerRegistrationKeys.LOGGER).info(
      `[/store/mbs/applications] emails skipped — RESEND_API_KEY/RESEND_FROM_EMAIL not set. New application from ${businessName} (${email}). Customer: ${customerId ?? "(duplicate)"}.`
    )
  }

  return res.json({ ok: true, customerId })
}

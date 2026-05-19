import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /store/mbs/customers/me/documents
 * Multipart body:
 *   - kind: "ein" | "resale"
 *   - file: the document (PDF / JPG / PNG / HEIC, up to 10 MB)
 *
 * Buyer-facing endpoint for re-uploading their EIN doc or Resale
 * Certificate from the /account page. Mirrors the apply form's
 * upload pattern (Multer + MinIO via Modules.FILE + customer
 * metadata stamp). Single file per request — the apply form uploads
 * both at once during signup; this route's job is per-document
 * replacement after signup.
 *
 * Auth: bearer token (customer session). Medusa's /store auth
 * middleware populates `req.auth_context.actor_id` with the customer
 * id when a valid bearer is present; we use that as the target for
 * the metadata update so a buyer can only ever update THEIR own docs.
 *
 * Side effect on success:
 *   customer.metadata.{kind}_doc_url       ← MinIO URL of the new file
 *   customer.metadata.{kind}_doc_filename  ← original filename for display
 *   customer.metadata.{kind}_doc_uploaded_at ← ISO timestamp
 *   customer.metadata.documents_updated_at ← rollup timestamp (admin visibility)
 */

type UploadedFile = {
  fieldname: string
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
])

const KIND_TO_META: Record<"ein" | "resale", {
  url: string
  filename: string
  uploadedAt: string
}> = {
  ein:    { url: "ein_doc_url",    filename: "ein_doc_filename",    uploadedAt: "ein_doc_uploaded_at" },
  resale: { url: "resale_doc_url", filename: "resale_doc_filename", uploadedAt: "resale_doc_uploaded_at" },
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  /* Auth — bearer-derived customer id. Medusa's auth middleware on
   * /store/* populates this when a valid customer bearer is present. */
  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  /* Validate kind. */
  const kindRaw = String((req.body as Record<string, unknown> | null)?.kind ?? "").toLowerCase()
  if (kindRaw !== "ein" && kindRaw !== "resale") {
    return res.status(400).json({ ok: false, message: 'kind must be "ein" or "resale"' })
  }
  const kind = kindRaw as "ein" | "resale"

  /* Validate file. */
  const files = (req as unknown as { files?: Record<string, UploadedFile[]> }).files ?? {}
  const file = files.file?.[0]
  if (!file) {
    return res.status(400).json({ ok: false, message: "file is required" })
  }
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return res.status(400).json({
      ok: false,
      message: "Unsupported file type. Use PDF, JPG, PNG, or HEIC.",
    })
  }

  /* Upload to MinIO via the file module. Filename keeps customer id +
   * kind + timestamp so admin can list a buyer's docs chronologically
   * via the bucket if needed. Lowercase + sanitize the original name. */
  const fileService: any = req.scope.resolve(Modules.FILE)
  const ts = Date.now()
  const safeOrig = file.originalname
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "doc"
  const filename = `customers/${customerId}/${kind}-${ts}-${safeOrig}`

  let uploadedUrl: string | undefined
  try {
    const [created] = await fileService.createFiles([{
      filename,
      mimeType: file.mimetype,
      content: file.buffer.toString("base64"),
    }])
    uploadedUrl = created?.url as string | undefined
  } catch (e: any) {
    logger.error(`[customers/me/documents] upload failed for ${customerId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "File upload failed. Try again or email wholesale@hempmbs.com." })
  }
  if (!uploadedUrl) {
    return res.status(500).json({ ok: false, message: "File upload returned no URL" })
  }

  /* Stamp customer.metadata. Merge with existing — we don't want to
   * clobber the OTHER doc's URL/filename/timestamp, business fields,
   * payment_terms, etc. */
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const list = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => null)
  const customer = list?.[0]
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }
  const meta = (customer.metadata ?? {}) as Record<string, any>
  const keys = KIND_TO_META[kind]
  const nowIso = new Date().toISOString()

  try {
    await customerService.updateCustomers(customerId, {
      metadata: {
        ...meta,
        [keys.url]: uploadedUrl,
        [keys.filename]: file.originalname,
        [keys.uploadedAt]: nowIso,
        documents_updated_at: nowIso,
      },
    })
  } catch (e: any) {
    logger.error(`[customers/me/documents] metadata update failed for ${customerId}: ${e?.message}`)
    return res.status(500).json({
      ok: false,
      message: "Uploaded the file but couldn't update your profile. Please retry.",
    })
  }

  logger.info(`[customers/me/documents] ${kind} doc uploaded for ${customerId}: ${file.originalname}`)
  return res.json({
    ok: true,
    kind,
    url: uploadedUrl,
    filename: file.originalname,
    uploaded_at: nowIso,
  })
}

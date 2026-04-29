import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

/**
 * POST /admin/receiving/coa-upload
 *
 * Multipart form upload, accepts 1+ files in field "coas". Each file
 * goes through Medusa's file module — MinIO in prod (when env vars
 * present), local ./static/ in dev. Returns the persisted URLs so
 * the receiving review page can store them per row + survive draft
 * round-trips.
 *
 * Returns:
 *   { ok: true, files: [{ url, originalName, mimeType, size }, ...] }
 *
 * Errors per file are NOT fatal — the response includes everything
 * that succeeded plus a per-file error string for failures, so the
 * client can apply the wins and show specific errors for losses.
 */

type UploadedFile = {
  fieldname: string
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

const PREFIX = "coas"
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
])

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const files = (req as any).files as Record<string, UploadedFile[]> | undefined
  const list = files?.coas ?? []
  if (list.length === 0) {
    res.status(400).json({ ok: false, error: "No files uploaded — expected field 'coas'" })
    return
  }

  const fileService: any = req.scope.resolve(Modules.FILE)
  const ts = Date.now()

  const results = await Promise.all(list.map(async (f, i) => {
    if (!ALLOWED_MIMES.has(f.mimetype)) {
      return { ok: false as const, originalName: f.originalname, error: `Unsupported type ${f.mimetype}` }
    }
    const ext = f.originalname.includes(".") ? f.originalname.split(".").pop() : "bin"
    const safe = f.originalname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "coa"
    const filename = `${PREFIX}/${ts}-${i}-${safe}.${ext}`
    try {
      const [created] = await fileService.createFiles([{
        filename,
        mimeType: f.mimetype,
        content: f.buffer.toString("base64"),
      }])
      return {
        ok: true as const,
        url: created?.url as string,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
      }
    } catch (e: any) {
      return { ok: false as const, originalName: f.originalname, error: e?.message ?? "Upload failed" }
    }
  }))

  res.json({
    ok: true,
    files: results.filter((r) => r.ok),
    errors: results.filter((r) => !r.ok),
  })
}

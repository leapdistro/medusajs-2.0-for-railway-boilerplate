import multer from "multer"
import sharp from "sharp"
import { defineMiddlewares, type MedusaNextFunction, type MedusaRequest, type MedusaResponse } from "@medusajs/framework/http"

/**
 * Compresses inbound image uploads before they reach the route handler.
 *
 * Mutates `req.files[i].buffer` in place with a resized + re-encoded
 * JPEG (max 2000×2000, quality 85, mozjpeg). The downstream Medusa
 * `uploadFilesWorkflow` stores whatever buffer is on req.files, so this
 * runs once at the boundary and the stored file is small forever.
 *
 * Why server-side: client-side compression would require overriding
 * Medusa admin's image-picker UI (significant lift). Doing it here
 * normalises every upload path — admin product pictures, future custom
 * image-upload routes, etc. — without the admin UI noticing.
 *
 * Why JPEG (not WebP / AVIF): JPEG is universally supported in the
 * Medusa admin previews + email clients. WebP would shave another
 * ~25% but the storefront PDP carousel is the only consumer of these
 * URLs and it doesn't currently emit a <picture> fallback.
 *
 * Non-image files (PDFs, etc.) pass through untouched.
 */
async function compressUploadsMiddleware(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const files = (req as unknown as { files?: Array<{
    buffer?: Buffer
    mimetype?: string
    originalname?: string
    size?: number
  }> }).files
  if (!Array.isArray(files) || files.length === 0) return next()

  await Promise.all(files.map(async (file) => {
    if (!file?.buffer || !file.mimetype?.startsWith("image/")) return
    try {
      const original = file.buffer.length
      const compressed = await sharp(file.buffer)
        /* .rotate() with no args reads EXIF orientation and bakes the
         * rotation into the pixels. Without this, phone photos taken
         * in portrait end up sideways once EXIF is stripped. */
        .rotate()
        .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer()
      file.buffer = compressed
      file.mimetype = "image/jpeg"
      file.originalname = (file.originalname ?? "image").replace(/\.[^.]+$/, "") + ".jpg"
      file.size = compressed.length
      // eslint-disable-next-line no-console
      console.info(`[uploads-compress] ${file.originalname}: ${(original / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`)
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[uploads-compress] failed for ${file.originalname}: ${e?.message ?? e}`)
      /* Fall through with the original buffer — better to upload
       * uncompressed than fail the operator's image entirely. */
    }
  }))
  next()
}

/**
 * In-memory multer instance for the wholesale-application endpoint.
 *
 * Files arrive as Buffer in `req.files` (Express-multer style). We then hand
 * each one to Medusa's file service, which uploads to MinIO/Bucket. Memory
 * storage keeps things simple — applications are infrequent and files are
 * small (PDFs / scans, ~few MB each).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,  // 10 MB per file
    files: 2,                    // EIN doc + Resale Certificate only
  },
})

/**
 * Separate multer instance for supplier-invoice PDFs. Larger limit
 * (15 MB) since multi-page invoices with embedded scans can exceed
 * 10 MB. Single file per upload.
 */
const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
})

/**
 * COA upload — operator uploads compliance docs (PDFs/images) per
 * receiving line item. Up to 50 files at once for bulk-drop UX,
 * 10 MB each (lab COAs are typically 1-3 MB).
 */
const coaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 50 },
})

/**
 * Customer document upload — buyer re-uploads their EIN doc or Resale
 * Certificate from /account. Single file per request (the route
 * dispatches based on a `kind` form field). Same 10 MB ceiling as the
 * apply flow's individual doc uploads.
 */
const customerDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
})

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/mbs/applications",
      method: "POST",
      middlewares: [
        upload.fields([
          { name: "einDoc",     maxCount: 1 },
          { name: "licenseDoc", maxCount: 1 },
        ]),
      ],
    },
    {
      matcher: "/admin/receiving/extract",
      method: "POST",
      middlewares: [
        invoiceUpload.fields([
          { name: "invoice", maxCount: 1 },
        ]),
      ],
    },
    {
      matcher: "/admin/receiving/coa-upload",
      method: "POST",
      middlewares: [
        coaUpload.fields([
          { name: "coas", maxCount: 50 },
        ]),
      ],
    },
    {
      matcher: "/store/mbs/customers/me/documents",
      method: "POST",
      middlewares: [
        customerDocUpload.fields([
          { name: "file", maxCount: 1 },
        ]),
      ],
    },
    {
      /* KAJA / Authorize.net webhook signature verification needs the
       * exact bytes that were signed — re-serializing req.body to JSON
       * is unreliable (whitespace + key order can drift), so opt this
       * route into raw body preservation. The handler reads req.rawBody
       * (Buffer) to compute the HMAC-SHA512. */
      matcher: "/hooks/kaja-authnet",
      method: "POST",
      bodyParser: { preserveRawBody: true, sizeLimit: "1mb" },
    },
    {
      /* Medusa's default bodyParser sizeLimit is ~1 MB, which truncates
       * any phone-photo product image upload. The ceiling is raised to
       * 15 MB — enough headroom for full-resolution modern phone photos
       * (typically 8-12 MB at native quality) — and the
       * compressUploadsMiddleware normalises each image down to
       * ~150-300 KB JPEG before storage.
       *
       * Must stay in sync with the admin's client-side
       * __MAX_UPLOAD_FILE_SIZE__ in medusa-config.js; if they diverge,
       * the lower number wins and the operator sees a confusing
       * client-side rejection. */
      matcher: "/admin/uploads",
      method: "POST",
      bodyParser: { sizeLimit: "15mb" },
      middlewares: [compressUploadsMiddleware],
    },
  ],
})

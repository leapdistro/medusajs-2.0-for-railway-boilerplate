import multer from "multer"
import { defineMiddlewares } from "@medusajs/framework/http"

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
  ],
})

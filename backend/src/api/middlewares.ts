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
  ],
})

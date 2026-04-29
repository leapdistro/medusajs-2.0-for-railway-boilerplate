import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { extractInvoice } from "../../../../lib/ai-extraction"

/**
 * POST /admin/receiving/extract
 *
 * Multipart form upload:
 *   field: invoice (single PDF, ≤15 MB)
 *
 * Returns the typed JSON shape from extractInvoice() so the admin
 * Receiving page can pre-populate the review spreadsheet. No
 * persistence here — drafts live in React state until the operator
 * hits Save (Slice 2C).
 *
 * Multer middleware in src/api/middlewares.ts parses the upload —
 * the file arrives as req.files["invoice"][0].
 */

type UploadedFile = {
  fieldname: string
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const files = (req as any).files as Record<string, UploadedFile[]> | undefined
  const invoiceFile = files?.invoice?.[0]

  if (!invoiceFile) {
    res.status(400).json({ ok: false, error: "No file uploaded — expected field 'invoice' (PDF)" })
    return
  }

  if (invoiceFile.mimetype !== "application/pdf") {
    res.status(400).json({
      ok: false,
      error: `Expected PDF, got ${invoiceFile.mimetype}`,
    })
    return
  }

  const result = await extractInvoice(invoiceFile.buffer)

  if (!result.ok) {
    res.status(502).json({
      ok: false,
      error: result.error,
      raw: result.raw,
      tokensIn: result.inputTokens,
      tokensOut: result.outputTokens,
    })
    return
  }

  res.json({
    ok: true,
    data: result.data,
    fileName: invoiceFile.originalname,
    fileSize: invoiceFile.size,
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
  })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { extractStockInvoice } from "../../../../../lib/ai-stock-invoice"

/**
 * POST /admin/receiving/stock/extract — multipart, field `invoice` (one
 * PDF, ≤15 MB, parsed by the middleware in src/api/middlewares.ts).
 * Reads the invoice for the Receive stock screen (lib/ai-stock-invoice.ts).
 * Nothing is saved.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const file = ((req as any).files as Record<string, Array<{ mimetype: string; buffer: Buffer; originalname: string }>> | undefined)?.invoice?.[0]
  if (!file) {
    res.status(400).json({ ok: false, error: "No invoice uploaded." })
    return
  }
  if (file.mimetype !== "application/pdf") {
    res.status(400).json({ ok: false, error: "The invoice must be a PDF." })
    return
  }
  const result = await extractStockInvoice(file.buffer)
  if (result.ok === false) {
    res.status(502).json({ ok: false, error: "error" in result ? result.error : "The invoice couldn't be read." })
    return
  }
  res.json({ ok: true, data: result.data, fileName: file.originalname })
}

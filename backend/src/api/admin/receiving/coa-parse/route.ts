import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { extractCoa } from "../../../../lib/ai-coa-extraction"

/**
 * POST /admin/receiving/coa-parse
 *
 * Body: { coaUrl: string }
 *
 * Fetches the (already-uploaded) COA PDF from its URL, hands the bytes
 * to the COA extractor, and returns the parsed percentages. Runs after
 * the bulk-COA-upload step — so the URL is always one of our own
 * MinIO/local-file URLs and the fetch is cheap.
 *
 * Returns:
 *   { ok: true, thcaPercent, totalCannabinoidsPercent, notes, tokensIn, tokensOut }
 *
 * Errors:
 *   400 — missing coaUrl
 *   502 — fetch or AI call failed (error string in body)
 */

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { coaUrl?: string }
  const coaUrl = body.coaUrl?.trim()
  if (!coaUrl) {
    res.status(400).json({ ok: false, error: "coaUrl is required" })
    return
  }

  /* Fetch the COA bytes. We trust the URL because it came from our own
   * upload endpoint, but bound the size and timeout to fail fast on
   * anything weird. */
  let pdfBytes: Buffer
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const fetchRes = await fetch(coaUrl, { signal: controller.signal })
    clearTimeout(timer)
    if (!fetchRes.ok) {
      res.status(502).json({ ok: false, error: `Fetch ${coaUrl} → ${fetchRes.status}` })
      return
    }
    const arrayBuf = await fetchRes.arrayBuffer()
    if (arrayBuf.byteLength > 15 * 1024 * 1024) {
      res.status(502).json({ ok: false, error: "COA file too large (>15 MB)" })
      return
    }
    pdfBytes = Buffer.from(arrayBuf)
  } catch (e: any) {
    res.status(502).json({ ok: false, error: `Couldn't fetch COA: ${e?.message ?? String(e)}` })
    return
  }

  const result = await extractCoa(pdfBytes)
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
    thcaPercent: result.data!.thcaPercent,
    totalCannabinoidsPercent: result.data!.totalCannabinoidsPercent,
    notes: result.data!.notes,
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
  })
}

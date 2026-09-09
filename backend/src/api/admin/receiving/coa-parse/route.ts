import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { extractCoa, PrimaryCannabinoid } from "../../../../lib/ai-coa-extraction"

/**
 * POST /admin/receiving/coa-parse
 *
 * Body: { coaUrl: string, primary?: "THC-A" | "THC-P" | "CBD" | "CBG" }
 *
 * Fetches the (already-uploaded) COA PDF from its URL, hands the bytes
 * to the COA extractor, and returns the parsed percentages. Runs after
 * the bulk-COA-upload step — so the URL is always one of our own
 * MinIO/local-file URLs and the fetch is cheap.
 *
 * `primary` is the receiving branch the operator is working in. It picks
 * which compound the extractor treats as the headline value, and it is
 * NOT optional in practice: a hemp CBD/CBG COA lists THCa next to the
 * CBD/CBG line, so omitting it makes the extractor return the THCa
 * number for a CBD product (the 2026-09 defect where CBD PDPs, product
 * tiles and printed labels all showed the COA's THCa %). Omitting it
 * stays legal only for the THCa-first legacy callers.
 *
 * Returns:
 *   { ok: true, primary, thcaPercent, totalCannabinoidsPercent, notes, tokensIn, tokensOut }
 *   `thcaPercent` is the PRIMARY cannabinoid % for whichever branch was
 *   requested — the key name is legacy, not a claim about THCa.
 *
 * Errors:
 *   400 — missing coaUrl, or unrecognized primary
 *   502 — fetch or AI call failed (error string in body)
 */

const PRIMARY_VALUES: PrimaryCannabinoid[] = ["THC-A", "THC-P", "CBD", "CBG"]

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { coaUrl?: string; primary?: string }
  const coaUrl = body.coaUrl?.trim()
  if (!coaUrl) {
    res.status(400).json({ ok: false, error: "coaUrl is required" })
    return
  }

  /* Reject an unknown branch rather than silently falling back to the
   * THCa-first prompt — a silent fallback is exactly how CBD rows got
   * filled with THCa numbers. Absent is still allowed (legacy callers). */
  let primary: PrimaryCannabinoid | undefined
  if (body.primary != null) {
    const candidate = String(body.primary).trim().toUpperCase()
    const match = PRIMARY_VALUES.find((v) => v === candidate)
    if (!match) {
      res.status(400).json({
        ok: false,
        error: `Unknown primary "${body.primary}" — expected one of ${PRIMARY_VALUES.join(", ")}`,
      })
      return
    }
    primary = match
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

  const result = await extractCoa(pdfBytes, primary)
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
    primary: primary ?? null,
    thcaPercent: result.data!.thcaPercent,
    totalCannabinoidsPercent: result.data!.totalCannabinoidsPercent,
    batchId: result.data!.batchId,
    notes: result.data!.notes,
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
  })
}

import Anthropic from "@anthropic-ai/sdk"

/**
 * Anthropic-backed extractor for supplier invoices. Takes the raw PDF
 * bytes and returns a typed JSON shape ready to drive the Receiving
 * admin review page.
 *
 * Why Sonnet 4.6: tabular invoice extraction is well within Sonnet's
 * range. Inputs are small (a 3-page PDF runs ~20-40k input tokens,
 * which is < $0.10 per call). Don't reach for Opus unless we see real
 * accuracy misses.
 *
 * Strict-JSON contract: prompt instructs ONLY-JSON output (no fences,
 * no prose). We then defensively extract the first {...} object from
 * the response in case the model adds wrapper text — Sonnet 4.6 does
 * not support assistant-message prefill, so we can't force the
 * leading `{` token directly.
 */

const MODEL = "claude-sonnet-4-6"

export type ExtractedLineItem = {
  /** Strain or product name as listed on the invoice. */
  strainName: string
  /** Quantity in POUNDS. Always converted to lb if invoiced in another unit. */
  quantityLb: number
  /** Unit price in USD per POUND. */
  unitPricePerLb: number
  /** AI's best-guess strain type from common knowledge. null when uncertain
   *  or when the strain name is truncated/unfamiliar — operator picks
   *  manually in those cases. */
  strainType: "Indica" | "Sativa" | "Hybrid" | null
}

export type ExtractedSupplier = {
  name: string
  phone: string | null
  email: string | null
  address: string | null
}

export type ExtractedInvoice = {
  supplier: ExtractedSupplier
  invoiceNumber: string
  /** ISO 8601 — "YYYY-MM-DD". */
  invoiceDate: string
  lineItems: ExtractedLineItem[]
  /** Sum of any "Shipping" / "Freight" / similar non-product line items. 0 if none. */
  shippingTotal: number
  /** Sum of line item amounts (excludes shipping, tax). Optional — extract if present. */
  subtotal: number | null
  /** Invoice grand total (line items + shipping + tax, before any payments). */
  total: number
  /** Anything the model wants to flag — unclear fields, partial data, etc. */
  notes: string | null
}

const PROMPT = `You are a precise data extractor for cannabis wholesale supplier invoices. Extract the following from the attached PDF and return ONLY valid JSON matching this schema (no markdown code fences, no prose, no explanation):

{
  "supplier": { "name": string, "phone": string|null, "email": string|null, "address": string|null },
  "invoiceNumber": string,
  "invoiceDate": "YYYY-MM-DD",
  "lineItems": [ { "strainName": string, "quantityLb": number, "unitPricePerLb": number, "strainType": "Indica"|"Sativa"|"Hybrid"|null } ],
  "shippingTotal": number,
  "subtotal": number|null,
  "total": number,
  "notes": string|null
}

Rules:
1. lineItems contains ONLY product/strain rows. Do NOT include shipping, freight, handling, tax, fees, discounts, or any non-product rows.
2. shippingTotal = sum of any rows with "Shipping", "Freight", "Delivery", or similar in the description. If none, 0.
3. Quantities are in POUNDS. If the invoice uses oz, kg, grams, or "QPs", convert to pounds (1 lb = 16 oz = 453.592 g = 4 QPs). Use a decimal if non-integer (e.g. half-pound = 0.5).
4. unitPricePerLb is USD per POUND. If priced per oz, kg, etc., convert. Always a number, no currency symbol.
5. invoiceDate must be ISO 8601 ("YYYY-MM-DD"). Parse "Apr 27, 2026" → "2026-04-27", "4/27/26" → "2026-04-27".
6. supplier.address: combine into one string (street, city, state, ZIP). null if missing.
7. If a field is genuinely missing or unreadable, use null for optional fields. Don't guess.
8. strainType: classify each strain as "Indica", "Sativa", or "Hybrid" based on common cannabis-industry knowledge of the strain. Most well-known strains have a documented dominant type (e.g. Northern Lights = Indica, Sour Diesel = Sativa, GG4/Gorilla Glue = Hybrid). Use null ONLY if the strain name is truncated, unfamiliar, or genuinely ambiguous — DO NOT guess. Operator will fill nulls manually.
9. notes: use this to flag anything ambiguous — e.g. "Two strains had unclear pricing units, assumed per lb". null if no flags.
10. Return ONLY the JSON object. Start with { and end with }. No \`\`\` fences, no prose around it.`

export type ExtractInvoiceResult = {
  ok: boolean
  data?: ExtractedInvoice
  raw: string                  // raw model response (for debugging)
  inputTokens: number
  outputTokens: number
  error?: string
}

export async function extractInvoice(pdfBytes: Buffer): Promise<ExtractInvoiceResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, raw: "", inputTokens: 0, outputTokens: 0, error: "ANTHROPIC_API_KEY env var not set" }
  }

  const client = new Anthropic({ apiKey })
  const base64 = pdfBytes.toString("base64")

  let res: Anthropic.Messages.Message
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    })
  } catch (e: any) {
    return {
      ok: false,
      raw: "",
      inputTokens: 0,
      outputTokens: 0,
      error: `Anthropic API call failed (${e?.status ?? "unknown"}): ${e?.message ?? String(e)}`,
    }
  }

  const text = res.content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")

  /* Defensive extraction: the prompt asks for pure JSON, but if the
   * model wraps it in ```json fences or prose, grab the first {...}
   * object by brace-matching. */
  const jsonText = extractJsonObject(text)
  if (!jsonText) {
    return {
      ok: false,
      raw: text,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      error: "No JSON object found in model response",
    }
  }

  let data: ExtractedInvoice
  try {
    data = JSON.parse(jsonText) as ExtractedInvoice
  } catch (e: any) {
    return {
      ok: false,
      raw: text,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      error: `Model returned invalid JSON: ${e?.message ?? String(e)}`,
    }
  }

  return {
    ok: true,
    data,
    raw: text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  }
}

/**
 * Find the first balanced `{...}` JSON object in a string. Walks
 * character by character tracking brace depth, skipping over string
 * literals (so braces inside `"foo {bar}"` don't confuse the count).
 * Returns null if no balanced object is found.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === "\\" && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

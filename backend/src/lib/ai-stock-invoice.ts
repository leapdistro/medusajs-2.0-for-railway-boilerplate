import Anthropic from "@anthropic-ai/sdk"
import { extractJsonObject } from "./ai-extraction"

/**
 * Reads a supplier invoice for the Receive stock screen (resold brands:
 * papers, cones, wraps…). Besides quantity and cost it reads what the
 * screen matches and creates products from: UPC, brand, how many pieces
 * are in a box, how many boxes in a case, and the flavour / colour /
 * size that sets a line apart from its siblings, so "Zig-Zag Hemp Wraps
 * Grape" and "… Mango" become one product with a Flavour option.
 *
 * Quantities and costs come back in BOXES, converted from cases or
 * pieces when the invoice says how. The operator checks every line.
 *
 * Opus 5.5 at medium effort: invoices vary a lot and grouping lines into
 * products takes some judgement.
 */

const MODEL = "claude-opus-5-5"

export type StockInvoiceLine = {
  /** The line as printed. */
  description: string
  /** Product name without the option value or pack size, e.g. "Zig-Zag Hemp Wraps". */
  productName: string
  brand: string | null
  upc: string | null
  /** "Flavour" / "Colour" / "Size"…, when lines of one product differ by it. */
  optionName: string | null
  optionValue: string | null
  quantityBoxes: number
  costPerBox: number
  piecesPerBox: number | null
  pieceName: string | null
  boxesPerCase: number | null
}

export type StockInvoice = {
  supplier: { name: string; phone: string | null; email: string | null; address: string | null }
  invoiceNumber: string
  invoiceDate: string
  lineItems: StockInvoiceLine[]
  shippingTotal: number
  subtotal: number | null
  total: number
  notes: string | null
}

const PROMPT = `You are reading a wholesale supplier invoice for smoking accessories and similar resold products (rolling papers, cones, wraps, tips, lighters…). Return ONLY a JSON object, no fences or prose:

{
  "supplier": { "name": string, "phone": string|null, "email": string|null, "address": string|null },
  "invoiceNumber": string,
  "invoiceDate": "YYYY-MM-DD",
  "lineItems": [ {
    "description": string,
    "productName": string,
    "brand": string|null,
    "upc": string|null,
    "optionName": string|null,
    "optionValue": string|null,
    "quantityBoxes": number,
    "costPerBox": number,
    "piecesPerBox": number|null,
    "pieceName": string|null,
    "boxesPerCase": number|null
  } ],
  "shippingTotal": number,
  "subtotal": number|null,
  "total": number,
  "notes": string|null
}

Rules:
1. lineItems holds product lines only: no shipping, freight, tax, fees or discounts. shippingTotal is the sum of shipping / freight / delivery lines, 0 if none.
2. description: the line exactly as printed.
3. We stock and sell by the BOX (a display box of booklets, pouches, cones…). quantityBoxes is how many boxes came in and costPerBox the USD cost of one box.
   - A line priced per case or master case: if the invoice says how many boxes are in a case, quantityBoxes = cases × boxesPerCase and costPerBox = case price ÷ boxesPerCase. If it doesn't say, keep the numbers as printed and flag the line in notes.
   - A line priced per piece (each booklet / pack / cone) with the count per box known: convert to boxes the same way. Otherwise keep the numbers and flag it.
4. piecesPerBox: how many sellable pieces are in one box (e.g. "24ct", "50/box", "Box of 25"), null if not printed. pieceName: what one piece is, plural ("booklets", "pouches", "cones", "packs"), null if unclear.
5. boxesPerCase: boxes in one case when printed (e.g. "Case 12/25" → 12 boxes of 25), else null.
6. brand: the manufacturer brand as normally written ("RAW", "Zig-Zag", "Elements", "Juicy Jay's"), from the line or its section heading. null if none.
7. upc: the 12 or 13 digit UPC / EAN of the line when printed, digits only. Not the supplier's item code. null if none.
8. Grouping: when several lines are the same product in different flavours, colours or sizes, give them the same productName (brand + product, without the variant word and without the box count, e.g. "Zig-Zag Hemp Wraps") and put the difference in optionName ("Flavour", "Colour", "Size") and optionValue ("Grape", "Mango"). A line that stands alone has optionName and optionValue null and productName as the product's usual name. Never invent a flavour that isn't printed.
9. invoiceDate in ISO ("Nov 12, 2026" → "2026-11-12"). Numbers without currency symbols. Use null for anything not printed; don't guess.
10. notes: short flags for anything unclear (a unit you couldn't convert, a total that doesn't add up). null if none.`

export type ExtractStockInvoiceResult =
  | { ok: true; data: StockInvoice; inputTokens: number; outputTokens: number }
  | { ok: false; error: string; raw?: string }

export async function extractStockInvoice(pdfBytes: Buffer): Promise<ExtractStockInvoiceResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY env var not set" }
  const client = new Anthropic({ apiKey })

  let res: Anthropic.Messages.Message
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") } },
          { type: "text", text: PROMPT },
        ],
      }],
    })
  } catch (e: any) {
    return { ok: false, error: `The invoice reader failed (${e?.status ?? "unknown"}): ${e?.message ?? String(e)}` }
  }
  if (res.stop_reason === "refusal") return { ok: false, error: "The invoice reader declined this file." }
  if (res.stop_reason === "max_tokens") return { ok: false, error: "The invoice is too long to read in one go. Split it, or type the lines." }

  const text = res.content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
  const json = extractJsonObject(text)
  if (!json) return { ok: false, error: "The invoice reader returned no data.", raw: text }
  try {
    const data = JSON.parse(json) as StockInvoice
    if (!Array.isArray(data.lineItems)) return { ok: false, error: "The invoice reader returned no lines.", raw: text }
    return { ok: true, data, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
  } catch (e: any) {
    return { ok: false, error: `The invoice reader returned bad data: ${e?.message ?? e}`, raw: text }
  }
}

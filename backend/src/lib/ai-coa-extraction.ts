import Anthropic from "@anthropic-ai/sdk"

/**
 * Anthropic-backed extractor for cannabis lab COA PDFs. Pulls out
 * THCa% and Total Cannabinoids% — the two compliance values the
 * receiving page collects per row.
 *
 * Why Sonnet 4.6: COAs are dense single-page lab reports; layout
 * varies wildly between labs. Sonnet handles the variety. Cost is
 * ~3-5k input + 50 output tokens per COA = ~$0.015 per file.
 *
 * Defensive parsing: same `extractJsonObject` brace-matcher as the
 * invoice extractor — model is told to output pure JSON, but if it
 * adds prose we recover.
 */

const MODEL = "claude-sonnet-4-6"

export type ExtractedCoa = {
  /** % weight, e.g. 24.31. null if not found / unreadable. */
  thcaPercent: number | null
  /** Sum of all cannabinoids %, e.g. 28.04. null if not found. */
  totalCannabinoidsPercent: number | null
  /** Lab Sample / Test / Batch identifier. Free-form (labs use varied
   *  formats). Printed on the wholesale label so buyers can cross-
   *  reference the original COA. null if not found / unreadable. */
  batchId: string | null
  /** AI's flag for anything ambiguous (multiple THCa values, decarb only, etc.). */
  notes: string | null
}

export type ExtractCoaResult = {
  ok: boolean
  data?: ExtractedCoa
  raw: string
  inputTokens: number
  outputTokens: number
  error?: string
}

/** Primary cannabinoid the extractor should target. Drives rule 1 of the
 *  prompt. THC-P Flower COAs report THCP where THC-A Flower COAs report
 *  THCa; the extractor targets whichever the caller expects. Undefined
 *  keeps the historical behavior (THCa-first with THC-P fallback). */
export type PrimaryCannabinoid = "THC-A" | "THC-P"

function buildPrompt(primary?: PrimaryCannabinoid): string {
  const rule1 =
    primary === "THC-P"
      ? `1. thcaPercent (holds primary cannabinoid %, misnamed for schema backward-compat): the % weight of THCP (tetrahydrocannabiphorol). Look for labels like "THCP", "THC-P", "Δ9-THCP", "THCPa". Return as a number only — no "%", no quotes. e.g. 3.24. If the COA reports both acid (THCPa) and neutral (THCP) forms, return the RAW acid value.`
      : primary === "THC-A"
      ? `1. thcaPercent: the % weight of THCa (tetrahydrocannabinolic acid). Look for labels like "THCa", "THC-A", "THCA", "Δ9-THCa". Return as a number only — no "%", no quotes. e.g. 24.31. If the COA reports both raw and decarboxylated forms, return the RAW THCa value (not the calculated/decarbed Total THC).`
      : `1. thcaPercent: the % weight of the PRIMARY compliance cannabinoid on this COA. Prefer THCa when present (labels: "THCa", "THC-A", "THCA", "Δ9-THCa"). If THCa is absent or below LOQ, use THCP instead (labels: "THCP", "THC-P", "Δ9-THCP", "THCPa"). Return as a number only — no "%", no quotes. If raw + decarbed values both appear, use RAW.`
  return `You are a precise data extractor for cannabis lab Certificate of Analysis (COA) PDFs. Extract the following from the attached PDF and return ONLY valid JSON matching this schema (no markdown code fences, no prose, no explanation):

{
  "thcaPercent": number|null,
  "totalCannabinoidsPercent": number|null,
  "batchId": string|null,
  "notes": string|null
}

Rules:
${rule1}
2. totalCannabinoidsPercent: the % weight of Total Cannabinoids. Look for labels like "Total Cannabinoids", "Total Active Cannabinoids", "Σ Cannabinoids". This is the sum of all detected cannabinoids — should be HIGHER than the primary cannabinoid value alone. Return as number only.
3. batchId: the lab's unique identifier for THIS test/sample. Look for labels like "Sample ID", "Sample #", "Sample No.", "Test ID", "Test #", "Batch ID", "Batch #", "Lab ID", "Report ID", "Order #", "Certificate #". Return the identifier exactly as printed, including any prefix/format (e.g. "S-12345", "1A4-N7-K2", "2024-0098-A"). Prefer the most specific test-level ID over a general report ID. Strip surrounding whitespace only. Return as a string.
4. If any value is genuinely missing, unreadable, or below LOQ/LOD, use null. Do NOT guess. Do NOT return 0 or empty string for missing values.
5. notes: flag anything ambiguous — e.g. "Two THCa values listed (raw + decarb), used raw", "Both THCa and THCP present, used THCa per rule", or "Two IDs present (Sample + Order), used Sample". null if clean.
6. Return ONLY the JSON object. Start with { and end with }. No \`\`\` fences, no prose around it.`
}

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

export async function extractCoa(
  pdfBytes: Buffer,
  primary?: PrimaryCannabinoid,
): Promise<ExtractCoaResult> {
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
      max_tokens: 512,  // tiny output — just the percentages
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 },
            },
            { type: "text", text: buildPrompt(primary) },
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

  let data: ExtractedCoa
  try {
    data = JSON.parse(jsonText) as ExtractedCoa
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

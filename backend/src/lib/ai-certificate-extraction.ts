import Anthropic from "@anthropic-ai/sdk"
import { extractJsonObject } from "./ai-extraction"

/**
 * Reads a wholesale applicant's resale certificate / sales-tax permit
 * (photo or PDF) so the signup form can fill in the licence number and
 * check the business name. The applicant always sees the result in an
 * editable field, and the operator still checks the file by hand, so a
 * miss only means the buyer types the number.
 *
 * Opus 5.5 at low effort: state forms vary a lot (Texas sales-tax
 * permit, multistate resale certificates, phone photos at an angle),
 * and the output is a handful of short fields.
 */

const MODEL = "claude-opus-5-5"

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const
type ImageType = (typeof IMAGE_TYPES)[number]

export type ExtractedCertificate = {
  /** Permit / certificate / taxpayer number as printed. */
  licenseNumber: string | null
  /** Business (legal or DBA) name the certificate is issued to. */
  businessName: string | null
  /** Two-letter state that issued it. */
  state: string | null
  /** True when the number is clearly legible. */
  confident: boolean
}

export type ExtractCertificateResult =
  | { ok: true; data: ExtractedCertificate; inputTokens: number; outputTokens: number }
  | { ok: false; error: string }

const PROMPT = `This is a US resale certificate, sales-tax permit or seller's permit uploaded by a store applying for a wholesale account.

Return only this JSON object:
{
  "licenseNumber": string|null,
  "businessName": string|null,
  "state": string|null,
  "confident": boolean
}

Rules:
1. licenseNumber: the permit, certificate, taxpayer or account number exactly as printed (keep dashes). Not a date, phone number, ZIP or the seller's/vendor's number on a resale form: on a resale certificate it is the purchaser's number.
2. businessName: the name of the business the document is issued to (on a resale certificate, the purchaser), as printed.
3. state: the issuing state as a two-letter code.
4. confident: true only if the licence number is clearly legible and you are sure which number it is.
5. If the document is not a resale certificate or permit, or a field can't be read, use null for it and confident: false.`

export function isReadableCertificateType(mimeType: string): boolean {
  return mimeType === "application/pdf" || (IMAGE_TYPES as readonly string[]).includes(mimeType)
}

export async function extractCertificate(bytes: Buffer, mimeType: string): Promise<ExtractCertificateResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY env var not set" }
  if (!isReadableCertificateType(mimeType)) return { ok: false, error: `Unsupported file type ${mimeType}` }

  const client = new Anthropic({ apiKey })
  const data = bytes.toString("base64")
  const source: Anthropic.Messages.ContentBlockParam =
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: mimeType as ImageType, data } }

  let res: Anthropic.Messages.Message
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: [source, { type: "text", text: PROMPT }] }],
    })
  } catch (e: any) {
    return { ok: false, error: `Anthropic API call failed (${e?.status ?? "unknown"}): ${e?.message ?? String(e)}` }
  }

  if (res.stop_reason === "refusal") return { ok: false, error: "Model declined the document" }

  const text = res.content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
  const jsonText = extractJsonObject(text)
  if (!jsonText) return { ok: false, error: "No JSON object found in model response" }

  let raw: any
  try {
    raw = JSON.parse(jsonText)
  } catch (e: any) {
    return { ok: false, error: `Model returned invalid JSON: ${e?.message ?? String(e)}` }
  }

  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null
  const state = str(raw.state, 2)?.toUpperCase() ?? null
  return {
    ok: true,
    data: {
      licenseNumber: str(raw.licenseNumber, 40),
      businessName: str(raw.businessName, 120),
      state: state && /^[A-Z]{2}$/.test(state) ? state : null,
      confident: raw.confident === true,
    },
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  }
}

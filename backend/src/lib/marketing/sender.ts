import { Resend } from "resend"

/**
 * The one place marketing email leaves the building. Swap the provider
 * here (e.g. if Resend declines hemp marketing) without touching the
 * editor, audience or queue.
 *
 * Env:
 *   MARKETING_FROM_EMAIL      e.g. "Mind Body Spirit <hello@news.hempmbs.com>" (required to send)
 *   MARKETING_RESEND_API_KEY  optional separate Resend account/key; falls back to RESEND_API_KEY
 *   MARKETING_REPLY_TO        defaults to wholesale@hempmbs.com
 */

export type OutgoingEmail = {
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
  tags?: Array<{ name: string; value: string }>
}
export type SendResult = { id: string | null; error: string | null }

export interface MarketingSender {
  /** Up to `maxBatch` emails; one result per email, same order. */
  sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]>
  readonly maxBatch: number
  /** Minimum pause between batches (provider rate limit). */
  readonly pauseMs: number
}

export function senderStatus(): { ready: boolean; from: string | null; reason: string | null } {
  const from = process.env.MARKETING_FROM_EMAIL?.trim() || null
  const key = process.env.MARKETING_RESEND_API_KEY || process.env.RESEND_API_KEY
  if (!from) return { ready: false, from, reason: "Marketing sending isn't set up yet (MARKETING_FROM_EMAIL is empty)." }
  if (!key) return { ready: false, from, reason: "Marketing sending isn't set up yet (no Resend API key)." }
  return { ready: true, from, reason: null }
}

class ResendMarketingSender implements MarketingSender {
  readonly maxBatch = 100
  readonly pauseMs = 600
  private client: Resend
  constructor(private from: string, apiKey: string, private replyTo: string) {
    this.client = new Resend(apiKey)
  }
  async sendBatch(emails: OutgoingEmail[]): Promise<SendResult[]> {
    if (!emails.length) return []
    const payload = emails.map((e) => ({
      from: this.from,
      to: [e.to],
      replyTo: this.replyTo,
      subject: e.subject,
      html: e.html,
      text: e.text,
      headers: e.headers,
      tags: e.tags,
    }))
    /* The SDK returns { error } instead of throwing; network errors throw. */
    try {
      const { data, error } = await this.client.batch.send(payload as any)
      if (error || !data) {
        const msg = `${error?.name ?? "error"}: ${error?.message ?? "Resend rejected the batch"}`
        return emails.map(() => ({ id: null, error: msg }))
      }
      return emails.map((_, i) => ({ id: data.data?.[i]?.id ?? null, error: data.data?.[i]?.id ? null : "No id returned" }))
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      return emails.map(() => ({ id: null, error: msg }))
    }
  }
}

let override: MarketingSender | null = null
/** Tests swap in a fake sender. */
export function setMarketingSenderForTests(s: MarketingSender | null) { override = s }

export function marketingSender(): MarketingSender | null {
  if (override) return override
  const st = senderStatus()
  if (!st.ready) return null
  return new ResendMarketingSender(
    st.from!,
    (process.env.MARKETING_RESEND_API_KEY || process.env.RESEND_API_KEY)!,
    process.env.MARKETING_REPLY_TO?.trim() || "wholesale@hempmbs.com",
  )
}

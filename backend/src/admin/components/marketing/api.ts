/* Admin → Marketing: types + fetch helpers shared by the list and editor. */

export type Block =
  | { id: string; type: "heading"; text: string; highlight?: string }
  | { id: string; type: "text"; text: string }
  | { id: string; type: "button"; label: string; url: string }
  | { id: string; type: "image"; url: string; alt: string; link?: string }
  | { id: string; type: "products"; title?: string; productIds: string[]; layout: "grid" | "list"; showPrices: boolean; fill?: "new" | "restock"; max?: number }
  | { id: string; type: "spacer"; size: "s" | "m" | "l" }
  | { id: string; type: "promise"; intro: string; items: string[] }

export type Audience = {
  mode: "all" | "filter" | "pick"
  pricingModes: string[]
  states: string[]
  businessTypes: string[]
  customerIds: string[]
  exclude: string[]
}

export type Campaign = {
  id: string
  name: string
  subject: string
  preheader: string
  blocks: Block[]
  audience: Audience
  status: "draft" | "scheduled" | "sending" | "sent" | "cancelled" | "failed" | "template"
  scheduled_at: string | null
  started_at: string | null
  sent_at: string | null
  recipient_count: number
  sent_count: number
  failed_count: number
  last_error: string | null
  source: { type: string; id: string; invoice?: string | null } | null
  last_test_at: string | null
  template_role: "receiving" | null
  created_at: string
  updated_at: string
}

export type Sending = { ready: boolean; from: string | null; reason: string | null }

export type PickerProduct = {
  id: string; title: string; image: string | null; badge: string; category: string
  colors: { swatch: string; surface: string; edge: string }; inStock: boolean; createdAt: string
}

export type MarketingCustomer = {
  id: string; email: string; name: string; company: string; pricingMode: string; pricingLabel: string
  state: string; businessType: string; suppressed: string | null
}

export type AudienceInfo = {
  count: number
  suppressed: Array<{ email: string; company: string; reason: string }>
  approvedTotal: number
  options: {
    pricingModes: Array<{ value: string; label: string; count: number }>
    states: Array<{ value: string; count: number }>
    businessTypes: Array<{ value: string; count: number }>
  }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    credentials: "include",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err: any = new Error(json?.message ?? `Request failed (${res.status})`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json as T
}

export const uid = () => Math.random().toString(36).slice(2, 10)

export const STATUS_LABEL: Record<Campaign["status"], { label: string; color: "grey" | "orange" | "blue" | "green" | "red" | "purple" }> = {
  draft: { label: "Draft", color: "grey" },
  scheduled: { label: "Scheduled", color: "purple" },
  sending: { label: "Sending", color: "blue" },
  sent: { label: "Sent", color: "green" },
  cancelled: { label: "Stopped", color: "orange" },
  failed: { label: "Failed", color: "red" },
  template: { label: "Template", color: "blue" },
}

export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""

export async function uploadImage(file: File): Promise<string> {
  const fd = new FormData()
  fd.append("files", file, file.name.replace(/[^A-Za-z0-9._-]+/g, "-") || "image.jpg")
  const res = await fetch("/admin/uploads", { method: "POST", credentials: "include", body: fd })
  const json = await res.json().catch(() => ({}))
  const url = json?.files?.[0]?.url
  if (!res.ok || !url) throw new Error(json?.message ?? `Upload failed (${res.status})`)
  return url
}

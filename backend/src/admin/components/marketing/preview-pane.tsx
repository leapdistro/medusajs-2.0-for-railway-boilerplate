import { Text } from "@medusajs/ui"
import { useEffect, useRef, useState } from "react"
import { api, type Block, type MarketingCustomer } from "./api"

/**
 * Live preview: the backend renders the unsaved content with the real
 * email renderer (so this IS the email), priced for the chosen buyer.
 * Re-renders 300ms after typing stops; the last frame stays up meanwhile.
 */
export function PreviewPane({ campaignId, subject, preheader, blocks, customers }: {
  campaignId: string; subject: string; preheader: string; blocks: Block[]; customers: MarketingCustomer[]
}) {
  const [html, setHtml] = useState("")
  const [width, setWidth] = useState<"desktop" | "phone">("desktop")
  const [viewAs, setViewAs] = useState("")
  const [unavailable, setUnavailable] = useState<Array<{ id: string; title: string }>>([])
  const [busy, setBusy] = useState(false)
  /* As rendered (templates fill receiving words with sample numbers). */
  const [shown, setShown] = useState<{ subject: string; preheader: string } | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const r = await api<{ html: string; unavailable: Array<{ id: string; title: string }>; subject?: string; preheader?: string }>(
          `/admin/marketing/campaigns/${campaignId}/preview`,
          { body: { subject, preheader, blocks, viewAs: viewAs || undefined } },
        )
        if (mine === seq.current) {
          setHtml(r.html); setUnavailable(r.unavailable)
          setShown(typeof r.subject === "string" ? { subject: r.subject, preheader: r.preheader ?? "" } : null)
        }
      } catch {
        /* keep the last frame */
      } finally {
        if (mine === seq.current) setBusy(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [campaignId, subject, preheader, JSON.stringify(blocks), viewAs])

  const viewer = customers.find((c) => c.id === viewAs)

  return (
    <div className="flex flex-col gap-2" style={{ height: "100%" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-md border border-ui-border-base overflow-hidden">
          {(["desktop", "phone"] as const).map((w) => (
            <button key={w} type="button" onClick={() => setWidth(w)} className={`px-3 py-1 txt-compact-small ${w === width ? "bg-ui-bg-base-pressed font-medium" : "bg-ui-bg-base text-ui-fg-subtle"}`}>
              {w === "desktop" ? "Desktop" : "Phone"}
            </button>
          ))}
        </div>
        <select
          value={viewAs}
          onChange={(e) => setViewAs(e.target.value)}
          className="rounded-md border border-ui-border-base bg-ui-bg-field px-2 py-1 txt-compact-small"
          style={{ maxWidth: 280 }}
        >
          <option value="">View as: default prices</option>
          {customers.map((c) => <option key={c.id} value={c.id}>View as: {c.company || c.name || c.email} ({c.pricingLabel})</option>)}
        </select>
        <Text size="xsmall" className="text-ui-fg-muted">{busy ? "Updating…" : viewer ? `Prices for ${viewer.pricingLabel}` : ""}</Text>
      </div>

      <div className="rounded-md border border-ui-border-base bg-ui-bg-subtle px-3 py-2">
        <Text size="small" weight="plus" className="truncate">{(shown?.subject ?? subject) || <span className="text-ui-fg-muted">No subject yet</span>}</Text>
        <Text size="xsmall" className="text-ui-fg-subtle truncate">{(shown?.preheader ?? preheader) || "No preview line"}</Text>
      </div>

      {unavailable.length ? (
        <div className="rounded-md px-3 py-2" style={{ background: "var(--tag-orange-bg, #fff7ed)" }}>
          <Text size="small">Left out of the email (sold out, hidden or deleted): {unavailable.map((u) => u.title).join(", ")}</Text>
        </div>
      ) : null}

      <div className="rounded-md border border-ui-border-base flex justify-center" style={{ background: "#e9e6dc", height: "calc(100vh - 190px)", minHeight: 560, overflow: "hidden" }}>
        <iframe
          title="Email preview"
          srcDoc={html}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          style={{ width: width === "phone" ? 390 : "100%", maxWidth: 680, height: "100%", border: 0, background: "#FFF9ED", transition: "width 160ms" }}
        />
      </div>
    </div>
  )
}

import { Badge, Input, Text } from "@medusajs/ui"
import { useEffect, useMemo, useState } from "react"
import { api, type Audience, type AudienceInfo, type MarketingCustomer } from "./api"

/**
 * Who gets it: all approved customers, a filter (pricing mode / state /
 * business type), or customers ticked by hand. The live count comes from
 * the backend, so it matches what Send will queue.
 */

function Chip({ on, label, count, onClick }: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 txt-compact-small ${on ? "bg-ui-bg-base-pressed border-ui-border-strong font-medium text-ui-fg-base" : "bg-ui-bg-base border-ui-border-base text-ui-fg-subtle"}`}
    >
      {label}{count !== undefined ? <span className="text-ui-fg-muted"> · {count}</span> : null}
    </button>
  )
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

export function AudiencePicker({ audience, onChange, customers, readOnly }: {
  audience: Audience; onChange: (a: Audience) => void; customers: MarketingCustomer[]; readOnly?: boolean
}) {
  const [info, setInfo] = useState<AudienceInfo | null>(null)
  const [q, setQ] = useState("")

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      api<AudienceInfo>("/admin/marketing/audience", { body: { audience } }).then((r) => { if (!cancelled) setInfo(r) }).catch(() => {})
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [JSON.stringify(audience)])

  /* In Filter mode the list shows only who the filter matches (same rule
   * as lib/marketing/audience.ts matchesAudience), so unticking is about
   * the people actually in the audience. */
  const shown = useMemo(() => {
    const inFilter = (c: MarketingCustomer) =>
      audience.mode !== "filter" || (
        (!audience.pricingModes.length || audience.pricingModes.includes(c.pricingMode)) &&
        (!audience.states.length || audience.states.includes(c.state)) &&
        (!audience.businessTypes.length || audience.businessTypes.includes(c.businessType))
      )
    const s = q.trim().toLowerCase()
    return customers.filter((c) => inFilter(c) && (!s || `${c.company} ${c.name} ${c.email} ${c.state}`.toLowerCase().includes(s)))
  }, [customers, q, audience.mode, audience.pricingModes.join(), audience.states.join(), audience.businessTypes.join()])

  const set = (patch: Partial<Audience>) => onChange({ ...audience, ...patch })
  const picking = audience.mode === "pick"

  /* Select all / Deselect all act on the rows shown (so after a search,
   * only the matches), never on unsubscribed or bounced customers. */
  const tickable = shown.filter((c) => !c.suppressed).map((c) => c.id)
  const isTicked = (id: string) => (picking ? audience.customerIds.includes(id) : !audience.exclude.includes(id))
  const tickedCount = tickable.filter(isTicked).length
  const tickAll = (on: boolean) => {
    const ids = new Set(tickable)
    if (picking) {
      const rest = audience.customerIds.filter((x) => !ids.has(x))
      set({ customerIds: on ? [...rest, ...tickable] : rest })
    } else {
      const rest = audience.exclude.filter((x) => !ids.has(x))
      set({ exclude: on ? rest : [...rest, ...tickable] })
    }
  }
  const linkBtn = "txt-compact-small text-ui-fg-interactive hover:underline disabled:text-ui-fg-disabled disabled:no-underline"

  return (
    <div className="flex flex-col gap-3" style={readOnly ? { pointerEvents: "none", opacity: 0.7 } : undefined}>
      <div className="flex gap-2 flex-wrap">
        <Chip on={audience.mode === "all"} label="All approved customers" onClick={() => set({ mode: "all" })} />
        <Chip on={audience.mode === "filter"} label="Filter" onClick={() => set({ mode: "filter" })} />
        <Chip on={picking} label="Pick customers" onClick={() => set({ mode: "pick" })} />
      </div>

      {audience.mode === "filter" && info ? (
        <div className="flex flex-col gap-3 rounded-md border border-ui-border-base p-3">
          <Text size="xsmall" className="text-ui-fg-muted">Nothing ticked in a row = everyone for that row.</Text>
          <div>
            <Text size="small" weight="plus" className="mb-1">Pricing mode</Text>
            <div className="flex gap-2 flex-wrap">
              {info.options.pricingModes.map((o) => <Chip key={o.value} on={audience.pricingModes.includes(o.value)} label={o.label} count={o.count} onClick={() => set({ pricingModes: toggle(audience.pricingModes, o.value) })} />)}
            </div>
          </div>
          {info.options.states.length ? (
            <div>
              <Text size="small" weight="plus" className="mb-1">State</Text>
              <div className="flex gap-2 flex-wrap">
                {info.options.states.map((o) => <Chip key={o.value} on={audience.states.includes(o.value)} label={o.value} count={o.count} onClick={() => set({ states: toggle(audience.states, o.value) })} />)}
              </div>
            </div>
          ) : null}
          {info.options.businessTypes.length ? (
            <div>
              <Text size="small" weight="plus" className="mb-1">Business type</Text>
              <div className="flex gap-2 flex-wrap">
                {info.options.businessTypes.map((o) => <Chip key={o.value} on={audience.businessTypes.includes(o.value)} label={o.value} count={o.count} onClick={() => set({ businessTypes: toggle(audience.businessTypes, o.value) })} />)}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-md border border-ui-border-base">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-ui-border-base">
          <Text size="small" weight="plus" style={{ flex: 1 }}>
            {picking ? "Tick who gets it" : "Leave anyone out? Untick them"}
          </Text>
          <div style={{ width: 200 }}><Input size="small" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>
        {tickable.length ? (
          <div className="flex items-center gap-3 px-3 py-2 border-b border-ui-border-base bg-ui-bg-subtle">
            <button type="button" className={linkBtn} disabled={tickedCount === tickable.length} onClick={() => tickAll(true)}>
              {q.trim() ? "Select all matches" : "Select all"}
            </button>
            <button type="button" className={linkBtn} disabled={tickedCount === 0} onClick={() => tickAll(false)}>
              {q.trim() ? "Deselect all matches" : "Deselect all"}
            </button>
            <Text size="xsmall" className="text-ui-fg-muted" style={{ marginLeft: "auto" }}>{tickedCount} of {tickable.length} ticked</Text>
          </div>
        ) : null}
        <div style={{ maxHeight: 220, overflowY: "auto" }}>
          {shown.map((c) => {
            const included = isTicked(c.id)
            return (
              <label key={c.id} className="flex items-center gap-2 px-3 py-1 border-b border-ui-border-base last:border-b-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={included && !c.suppressed}
                  disabled={!!c.suppressed}
                  onChange={() => picking ? set({ customerIds: toggle(audience.customerIds, c.id) }) : set({ exclude: toggle(audience.exclude, c.id) })}
                />
                <Text size="small" className="truncate" style={{ flex: 1 }}>
                  {c.company || c.name || c.email}
                  <span className="text-ui-fg-muted"> · {c.email}</span>
                </Text>
                <Text size="xsmall" className="text-ui-fg-muted">{c.pricingLabel}{c.state ? ` · ${c.state}` : ""}</Text>
                {c.suppressed ? <Badge size="2xsmall" color="orange">{c.suppressed}</Badge> : null}
              </label>
            )
          })}
          {!shown.length ? <Text size="small" className="text-ui-fg-muted px-3 py-2">No customers match.</Text> : null}
        </div>
      </div>

      <div className="rounded-md bg-ui-bg-subtle px-3 py-2">
        {info ? (
          <Text size="small">
            <strong>{info.count}</strong> of {info.approvedTotal} approved customer{info.approvedTotal === 1 ? "" : "s"} will get it.
            {info.suppressed.length ? <span className="text-ui-fg-subtle"> {info.suppressed.length} unsubscribed or bounced, left out.</span> : null}
          </Text>
        ) : <Text size="small" className="text-ui-fg-subtle">Counting…</Text>}
      </div>
    </div>
  )
}

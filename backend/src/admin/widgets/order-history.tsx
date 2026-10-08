import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type Change = { label: string; before?: string | null; after?: string | null }
type Entry = {
  id: string
  at: string
  actor: { type: "admin" | "customer" | "system" | "qbo"; label: string }
  action: string
  summary: string
  changes?: Change[]
}

const ACTOR_COLOR: Record<Entry["actor"]["type"], "blue" | "green" | "grey" | "purple"> = {
  admin: "blue",
  customer: "green",
  system: "grey",
  qbo: "purple",
}

/**
 * Order History — every change to the order, newest first: edits with
 * before → after, fulfillment, returns, payments, cancellation, and each
 * QuickBooks sync. Built by GET /admin/orders/:id/history.
 */
const OrderHistoryWidget = ({ data }: DetailWidgetProps<{ id: string }>) => {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/orders/${data.id}/history`, { credentials: "include", cache: "no-store" })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `Failed (${res.status})`)
      setEntries(json.history ?? [])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load history")
    }
  }, [data?.id])

  useEffect(() => { load() }, [load])

  /* Changes made elsewhere on the page (edits, returns, background QBO
   * syncs) land here within ~15s while the tab is visible. */
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load() }, 15_000)
    return () => clearInterval(t)
  }, [load])

  const visible = showAll ? entries ?? [] : (entries ?? []).slice(0, 12)

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">History</Heading>
          <Text size="small" className="text-ui-fg-subtle">Every change to this order, newest first.</Text>
        </div>
        {entries ? <Text size="small" className="text-ui-fg-muted">{entries.length} events</Text> : null}
      </div>

      {error ? (
        <div className="px-6 py-4">
          <Text size="small" style={{ color: "var(--destructive, #B91C1C)" }}>{error}</Text>
        </div>
      ) : !entries ? (
        <div className="px-6 py-4"><Text size="small" className="text-ui-fg-muted">Loading…</Text></div>
      ) : (
        <ol className="px-6 py-2">
          {visible.map((e) => (
            <li key={e.id} className="flex gap-4 py-3 border-b last:border-b-0">
              <div className="w-36 shrink-0">
                <Text size="xsmall" className="text-ui-fg-muted">
                  {new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                </Text>
                <div className="mt-1"><Badge size="2xsmall" color={ACTOR_COLOR[e.actor.type]}>{e.actor.label}</Badge></div>
              </div>
              <div className="min-w-0 flex-1">
                <Text size="small" weight="plus">{e.summary}</Text>
                {e.changes?.length ? (
                  <ul className="mt-1">
                    {e.changes.map((c, i) => (
                      <li key={i}>
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          {c.label}
                          {c.before != null || c.after != null ? ": " : ""}
                          {c.before != null ? <span style={{ textDecoration: c.after != null ? "line-through" : undefined }}>{c.before}</span> : null}
                          {c.before != null && c.after != null ? " → " : ""}
                          {c.after != null ? <strong>{c.after}</strong> : null}
                        </Text>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {entries && entries.length > 12 ? (
        <div className="px-6 py-3">
          <Button variant="transparent" size="small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${entries.length}`}
          </Button>
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderHistoryWidget

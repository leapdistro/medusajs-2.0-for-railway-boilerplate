import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/**
 * Customer-list widget — "Clear Bell Notifications" button.
 *
 * The admin header bell drawer auto-clears the unread badge on open
 * (via Medusa's localStorage timestamp), but entries themselves stay
 * in DB forever. This gives operators an explicit nuke once they've
 * actioned everything in the feed.
 *
 * Mounts on customer.list.before because that's where operators land
 * to push QBO updates / approve applications — the same surface the
 * bell entries point back to. Hides entirely when feed count = 0
 * so the page stays clean once everything is cleared.
 *
 * Confirm dialog before delete — accidental click otherwise wipes
 * every operator's bell across the whole admin (the feed channel is
 * not per-user).
 */
const ClearBellNotificationsWidget = () => {
  const [count, setCount] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/admin/mbs/notifications/clear-feed", {
        credentials: "include",
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCount(typeof json?.count === "number" ? json.count : 0)
    } catch {
      setCount(0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const clearAll = async () => {
    setBusy(true)
    try {
      const res = await fetch("/admin/mbs/notifications/clear-feed", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(`Cleared ${json.deleted ?? count} bell notifications`)
      setCount(0)
      setConfirm(false)
    } catch (e: any) {
      toast.error(`Clear failed: ${e?.message ?? "unknown"}`)
    } finally {
      setBusy(false)
    }
  }

  /* Hide entirely when there's nothing to clear OR we couldn't fetch
   * the count — no point cluttering /customers with a dead button. */
  if (loading || count === 0) return null

  return (
    <Container className="divide-y p-0" style={{ marginBottom: 12 }}>
      <div className="px-6 py-4 flex items-center justify-between">
        <div>
          <Heading level="h2">Bell Notifications</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {count} notification{count === 1 ? "" : "s"} in the admin bell drawer.
            Clear them once you've addressed each one.
          </Text>
        </div>
        <Button
          variant="secondary"
          onClick={() => setConfirm(true)}
          isLoading={busy}
          disabled={busy}
        >
          Clear All ({count})
        </Button>
      </div>

      {confirm && (
        <div className="px-6 py-4" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Text size="small" weight="plus">
            Wipe all {count} bell notifications?
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            This is a hard delete — entries can&rsquo;t be recovered. The
            underlying records (orders, customers, applications) are
            untouched. Any new event will create a fresh bell entry.
          </Text>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="danger" onClick={clearAll} isLoading={busy} disabled={busy}>
              Yes, Clear All
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.list.before",
})

export default ClearBellNotificationsWidget

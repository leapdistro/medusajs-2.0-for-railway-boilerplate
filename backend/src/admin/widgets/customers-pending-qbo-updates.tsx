import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type PendingCustomer = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  qbo_sync_pending_at: string | null
  qbo_customer_id: string | null
}

/**
 * Customer list banner — surfaces every customer with
 * metadata.qbo_sync_pending = true so the operator can see at a glance
 * which buyers updated their profile / business / addresses without
 * having to open each customer detail page.
 *
 * Each row carries an inline "Push to QBO" button that calls the same
 * /admin/customers/:id/push-qbo-updates route the detail-page widget
 * uses. On success the row drops out of the banner on next fetch.
 *
 * Renders nothing when the list is empty — banner only appears when
 * there's something to do. Mounts on customer.list.before so it sits
 * above the customers table without disrupting the existing list UI.
 */
const CustomersPendingQboUpdatesBanner = () => {
  const [list, setList] = useState<PendingCustomer[]>([])
  const [loading, setLoading] = useState(true)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/admin/mbs/customers/pending-qbo-updates", {
        credentials: "include",
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setList((json?.customers ?? []) as PendingCustomer[])
    } catch {
      setList([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /* Shared row-action runner — both Push and Clear hit a per-customer
   * endpoint and, on success, drop the row from the list. The only
   * differences are the path + the success-toast copy, so parameterize. */
  const runRowAction = async (
    c: PendingCustomer,
    path: "push-qbo-updates" | "clear-qbo-pending",
    successMessage: string,
    failurePrefix: string,
  ) => {
    setBusyIds((prev) => new Set(prev).add(c.id))
    try {
      const res = await fetch(`/admin/customers/${c.id}/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(successMessage)
      /* Optimistically remove this row — both push and clear flip
       * qbo_sync_pending = false, so either way the buyer disappears
       * from the pending list on next fetch. */
      setList((prev) => prev.filter((x) => x.id !== c.id))
    } catch (e: any) {
      toast.error(`${failurePrefix}: ${e?.message ?? "unknown"}`)
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(c.id)
        return next
      })
    }
  }

  const pushOne = (c: PendingCustomer) =>
    runRowAction(c, "push-qbo-updates", `Pushed ${c.email} to QBO`, `Push failed for ${c.email}`)
  const clearOne = (c: PendingCustomer) =>
    runRowAction(c, "clear-qbo-pending", `Dismissed pending update for ${c.email}`, `Clear failed for ${c.email}`)

  /* Hide entirely when there's nothing to do — banner only surfaces
   * when action is needed. */
  if (loading || list.length === 0) return null

  return (
    <Container className="divide-y p-0" style={{ marginBottom: 12 }}>
      <div className="px-6 py-4">
        <Heading level="h2">Pending QBO Updates ({list.length})</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          These buyers updated their profile, business info, or address since the last push.
          Click <strong>Push</strong> to sync them to QuickBooks.
        </Text>
      </div>
      <div className="px-6 py-2">
        {list.map((c) => {
          const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim()
          const since = c.qbo_sync_pending_at
            ? new Date(c.qbo_sync_pending_at).toLocaleString(undefined, {
                dateStyle: "short", timeStyle: "short",
              })
            : null
          return (
            <div
              key={c.id}
              className="flex items-center justify-between py-2"
              style={{ borderBottom: "1px solid var(--ui-border-base)" }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <Text size="small" weight="plus">
                  {name || c.company_name || c.email}
                </Text>
                <Text size="xsmall" className="text-ui-fg-muted">
                  {c.email}
                  {c.company_name && name ? ` · ${c.company_name}` : ""}
                  {since ? ` · pending since ${since}` : ""}
                </Text>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => clearOne(c)}
                  isLoading={busyIds.has(c.id)}
                  disabled={busyIds.has(c.id)}
                >
                  Clear
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => pushOne(c)}
                  isLoading={busyIds.has(c.id)}
                  disabled={busyIds.has(c.id)}
                >
                  Push to QBO
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.list.before",
})

export default CustomersPendingQboUpdatesBanner

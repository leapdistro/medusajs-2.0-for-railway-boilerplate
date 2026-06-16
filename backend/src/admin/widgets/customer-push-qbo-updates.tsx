import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type CustomerLite = {
  id: string
  email?: string
  metadata?: Record<string, any> | null
}

/**
 * Customer detail widget — Push Updates to QBO.
 *
 * Shows ONLY when both of these are true on the customer:
 *   - metadata.qbo_customer_id        (a linked QBO Customer exists)
 *   - metadata.qbo_sync_pending = true (buyer touched a QBO-relevant
 *                                       field in /account since the
 *                                       last operator push)
 *
 * When neither condition is met the widget renders nothing — keeps the
 * customer detail page uncluttered for the common case where there's
 * nothing to push. Same self-refresh-on-mount pattern as the
 * approve-welcome widget so we don't reload the whole page on click.
 */
const CustomerPushQboUpdatesWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const [customer, setCustomer] = useState<CustomerLite | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/customers/${data.id}?fields=id,email,metadata`, {
        credentials: "include",
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCustomer(json?.customer ?? null)
    } catch {
      setCustomer(data)
    } finally {
      setLoading(false)
    }
  }, [data])

  useEffect(() => { refresh() }, [refresh])

  if (loading) return null

  const meta = (customer?.metadata ?? {}) as Record<string, any>
  const qboCustomerId = typeof meta.qbo_customer_id === "string" ? meta.qbo_customer_id : null
  const isPending = meta.qbo_sync_pending === true

  /* Hide the whole widget when there's nothing to surface — no
   * QBO link, no pending changes, or the customer hasn't synced at
   * all yet. Reduces visual noise on customer detail pages where
   * the common case is "nothing to do here". */
  if (!qboCustomerId || !isPending) return null

  const onClick = async () => {
    if (!customer?.id) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${customer.id}/push-qbo-updates`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(`Pushed updates to QBO Customer ${json.qboCustomerId ?? qboCustomerId}`)
      await refresh()
    } catch (e: any) {
      toast.error(`Push failed: ${e?.message ?? "unknown"}`)
    } finally {
      setBusy(false)
    }
  }

  const pendingSince = typeof meta.qbo_sync_pending_at === "string"
    ? new Date(meta.qbo_sync_pending_at)
    : null
  const pendingLabel = pendingSince
    ? pendingSince.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">QuickBooks Sync</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          This buyer changed their profile, business info, or address since the last QBO push.
          {pendingLabel ? ` First pending change: ${pendingLabel}.` : ""} Click below to push
          name / phone / company / address / EIN / license to QBO Customer{" "}
          <span style={{ fontFamily: "monospace" }}>{qboCustomerId}</span>.
        </Text>
        <div style={{ marginTop: 12 }}>
          <Button variant="primary" onClick={onClick} isLoading={busy} disabled={busy}>
            Push Updates to QBO
          </Button>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerPushQboUpdatesWidget

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

  /* Render whenever the buyer has pending changes — regardless of
   * whether QBO already knows them. The push-qbo-updates route
   * branches on qbo_customer_id (find-or-create when missing, sparse
   * update when present), so the operator can always hit "Push" to
   * make QBO match the current /account state. */
  if (!isPending) return null

  /* Shared runner — both Push (writes to QBO + clears flag) and Clear
   * (only clears the flag, no QBO touch) hit a per-customer endpoint
   * and then refresh the widget. Same shape, different path. */
  const runAction = async (
    path: "push-qbo-updates" | "clear-qbo-pending",
    onSuccess: (json: any) => string,
    failurePrefix: string,
  ) => {
    if (!customer?.id) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${customer.id}/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(onSuccess(json))
      await refresh()
    } catch (e: any) {
      toast.error(`${failurePrefix}: ${e?.message ?? "unknown"}`)
    } finally {
      setBusy(false)
    }
  }

  const onPush = () =>
    runAction(
      "push-qbo-updates",
      (json) => `Pushed updates to QBO Customer ${json.qboCustomerId ?? qboCustomerId}`,
      "Push failed",
    )
  const onClear = () =>
    runAction(
      "clear-qbo-pending",
      () => "Dismissed — pending flag cleared without pushing to QBO",
      "Clear failed",
    )

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
          name / phone / company / address / EIN / license to QBO
          {qboCustomerId ? (
            <>
              {" "}Customer{" "}
              <span style={{ fontFamily: "monospace" }}>{qboCustomerId}</span>.
            </>
          ) : (
            <> — the customer record will be created in QBO on this push (find-or-create).</>
          )}
        </Text>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <Button variant="primary" onClick={onPush} isLoading={busy} disabled={busy}>
            Push Updates to QBO
          </Button>
          <Button variant="secondary" onClick={onClear} isLoading={busy} disabled={busy}>
            Clear (Don&apos;t Push)
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

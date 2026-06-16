import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

const APPROVED_GROUP_NAME = "approved" // matches APPROVED_GROUP_NAME env on backend

type CustomerLite = {
  id: string
  email?: string
  metadata?: Record<string, any> | null
  groups?: Array<{ id: string; name: string }>
}

/**
 * Customer detail widget — single contextual button:
 *   - Not in "approved" group → "Approve & Send Welcome"
 *   - Already approved      → "Resend Welcome Email" (with last-sent timestamp)
 *
 * The `data` prop the admin passes in doesn't reliably include the `groups`
 * relation, so we fetch the customer fresh with groups + metadata expanded
 * via /admin/customers/:id?fields=… on mount and after each successful
 * action. This avoids a full page reload — the widget self-refreshes.
 */
const CustomerApproveWelcomeWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const [customer, setCustomer] = useState<CustomerLite | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/customers/${data.id}?fields=id,email,metadata,*groups`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCustomer(json?.customer ?? null)
    } catch (e: any) {
      // Fall back to whatever data the widget was given; the prop may not
      // include groups so the resend variant won't show, but the button
      // still works (idempotent on the backend).
      setCustomer(data)
    } finally {
      setLoading(false)
    }
  }, [data])

  useEffect(() => { refresh() }, [refresh])

  const inApproved = (customer?.groups ?? []).some(
    (g) => String(g?.name ?? "").toLowerCase() === APPROVED_GROUP_NAME
  )
  const welcomedAt = customer?.metadata?.welcomed_at as string | undefined
  const welcomedAtDate = welcomedAt ? new Date(welcomedAt) : null
  const justSent = welcomedAtDate && (Date.now() - welcomedAtDate.getTime() < 60_000)

  /* QBO sync state — persisted on customer.metadata by the push lib
   * (lib/customer-to-qbo.ts). Mutually exclusive:
   *   - qbo_push_error present → failed (red panel + Retry button)
   *   - qbo_customer_id present → synced (green check + QBO id)
   *   - neither → not yet attempted (nothing rendered) */
  const qboCustomerId = customer?.metadata?.qbo_customer_id as string | undefined
  const qboPushError = customer?.metadata?.qbo_push_error as string | undefined
  const qboPushErrorAt = customer?.metadata?.qbo_push_error_at as string | undefined

  const onClick = async () => {
    if (justSent) {
      const sec = Math.round((Date.now() - welcomedAtDate!.getTime()) / 1000)
      const ok = window.confirm(
        `Welcome email was sent ${sec} second${sec === 1 ? "" : "s"} ago. Send another?`
      )
      if (!ok) return
    }

    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${data.id}/approve-and-welcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        toast.error(json?.message ?? `Failed (${res.status})`)
        return
      }
      toast.success(
        json.groupAttached
          ? `Approved · welcome email sent to ${json.email}`
          : `Welcome email re-sent to ${json.email}`
      )
      /* Surface QBO sync outcome — non-blocking step but operator
       * needs to know if the customer didn't make it into QBO. The
       * persistent panel below renders the same state on every page
       * load; this toast is for immediate feedback only. */
      const qbo = json.qbo as { state: string; message?: string; qboCustomerId?: string; created?: boolean } | undefined
      if (qbo?.state === "error") {
        toast.warning("QBO sync failed", {
          description: `${qbo.message ?? "Click Retry QBO Push below after fixing the issue."}`,
        })
      } else if (qbo?.state === "synced" && qbo.created) {
        toast.success(`QBO Customer #${qbo.qboCustomerId} created`)
      }
      // Refresh widget state — picks up the group + new welcomed_at stamp
      // + the qbo_customer_id without forcing a full-page reload.
      await refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  /* Retry the QBO push without re-sending the welcome email. Hits
   * lib/customer-to-qbo.ts via the dedicated retry-qbo-push route.
   * On success the push lib clears qbo_push_error and stamps
   * qbo_customer_id; the refresh below picks both up. */
  const onRetryQbo = async () => {
    if (!data?.id) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${data.id}/retry-qbo-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) {
        toast.error(`QBO retry failed: ${json?.message ?? `HTTP ${res.status}`}`)
        await refresh()
        return
      }
      toast.success(
        json.created
          ? `Pushed to QBO · Customer #${json.qboCustomerId} created`
          : `QBO already synced · Customer #${json.qboCustomerId}`,
      )
      await refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  if (loading && !customer) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Approval</Heading>
          <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
        </div>
      </Container>
    )
  }

  const label = inApproved ? "Resend Welcome Email" : "Approve & Send Welcome"
  const lastSentLine = welcomedAtDate
    ? `Last sent: ${welcomedAtDate.toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      })}`
    : "Never sent"

  const errorAtFormatted = qboPushErrorAt
    ? new Date(qboPushErrorAt).toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      })
    : null

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Approval</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {inApproved
              ? "Customer is in the \"approved\" group. Resend the welcome email any time."
              : "Add the customer to the \"approved\" group and send their first welcome / password-setup email."}
          </Text>
          <Text size="small" className="text-ui-fg-muted mt-1">{lastSentLine}</Text>
        </div>
        <Button
          variant={inApproved ? "secondary" : "primary"}
          onClick={onClick}
          isLoading={busy}
        >
          {label}
        </Button>
      </div>

      {/* QBO sync state — persistent panel that survives page reloads.
        * Three states: failed (red), synced (green), neither (hidden). */}
      {qboPushError ? (
        <div
          className="px-6 py-4"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            borderLeft: "3px solid var(--ui-tag-red-text)",
            background: "var(--ui-tag-red-bg)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <Text size="small" weight="plus" style={{ color: "var(--ui-tag-red-text)" }}>
              QBO Sync Failed
            </Text>
            <Button variant="primary" size="small" onClick={onRetryQbo} isLoading={busy} disabled={busy}>
              Retry QBO Push
            </Button>
          </div>
          <Text size="small" className="text-ui-fg-subtle" style={{ wordBreak: "break-word" }}>
            {qboPushError}
          </Text>
          {errorAtFormatted ? (
            <Text size="xsmall" className="text-ui-fg-muted">
              Last attempt: {errorAtFormatted}
            </Text>
          ) : null}
        </div>
      ) : qboCustomerId ? (
        <div className="px-6 py-3 flex items-center gap-2">
          <span style={{ color: "var(--ui-tag-green-text)", fontWeight: 600 }}>✓</span>
          <Text size="small" className="text-ui-fg-subtle">
            QBO Customer #{String(qboCustomerId)} synced
          </Text>
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerApproveWelcomeWidget

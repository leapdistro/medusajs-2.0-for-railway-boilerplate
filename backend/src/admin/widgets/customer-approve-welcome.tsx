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
      // Refresh widget state — picks up the group + new welcomed_at stamp
      // without forcing a full-page reload.
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
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerApproveWelcomeWidget

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useState } from "react"

const APPROVED_GROUP_NAME = "approved" // matches APPROVED_GROUP_NAME env on backend

type CustomerLite = {
  id: string
  email: string
  metadata?: Record<string, any> | null
  groups?: Array<{ id: string; name: string }>
}

/**
 * Customer detail widget — single contextual button:
 *   - Not in "approved" group → "Approve & Send Welcome"
 *   - Already approved      → "Resend Welcome Email" (with last-sent timestamp)
 *
 * Either way, the click hits POST /admin/customers/:id/approve-and-welcome
 * which idempotently ensures group membership + triggers the welcome email
 * via Medusa's reset-password flow. Widget refreshes the page on success
 * so the rest of the admin UI (group list, metadata) reflects the change.
 */
const CustomerApproveWelcomeWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const [busy, setBusy] = useState(false)

  const inApproved = (data?.groups ?? []).some(
    (g) => String(g?.name ?? "").toLowerCase() === APPROVED_GROUP_NAME
  )
  const welcomedAt = data?.metadata?.welcomed_at as string | undefined
  const welcomedAtDate = welcomedAt ? new Date(welcomedAt) : null
  const justSent = welcomedAtDate && (Date.now() - welcomedAtDate.getTime() < 60_000)

  const onClick = async () => {
    // Confirm if last send was within 60s — guards accidental double-clicks
    // but supports legit "customer didn't get it, send again" support flow.
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
      // Refresh so groups + metadata in the admin UI reflect the change.
      setTimeout(() => window.location.reload(), 800)
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
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

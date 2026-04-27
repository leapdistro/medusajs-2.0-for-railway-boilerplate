import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useState } from "react"

const APPROVED_GROUP_NAME = "approved"

type CustomerLite = {
  id: string
  email?: string
  metadata?: Record<string, any> | null
  groups?: Array<{ id: string; name: string }>
}

type Reason = { id: string; label: string; archived?: boolean }
type SettingRow = { key: string; value: any }

/**
 * Customer detail widget — Deny Application.
 *
 * Sits next to the existing Approval widget. Shows different states:
 *   - Customer is in "approved" group → hides itself entirely (denying
 *     an approved customer should be a separate "revoke" flow, not this).
 *   - Already denied → shows the reason + timestamp + a "Re-deny / change
 *     reason" button that opens the form again.
 *   - Pending (default) → shows reason dropdown + optional operator note
 *     + Send button.
 *
 * Reasons come from /admin/mbs/settings (denial_reasons key) — operator
 * edits the list in MBS Settings without redeploying.
 */
const CustomerDenyApplicationWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const [customer, setCustomer] = useState<CustomerLite | null>(null)
  const [reasons, setReasons] = useState<Reason[]>([])
  const [reasonId, setReasonId] = useState<string>("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)

  const refreshCustomer = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/customers/${data.id}?fields=id,email,metadata,*groups`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCustomer(json?.customer ?? null)
    } catch {
      setCustomer(data)
    }
  }, [data])

  const loadReasons = useCallback(async () => {
    try {
      const res = await fetch("/admin/mbs/settings", { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const row = (json?.settings ?? []).find((r: SettingRow) => r.key === "denial_reasons")
      const list = (Array.isArray(row?.value) ? row.value : []) as Reason[]
      setReasons(list.filter((r) => !r.archived))
    } catch {
      setReasons([])
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([refreshCustomer(), loadReasons()]).finally(() => setLoading(false))
  }, [refreshCustomer, loadReasons])

  const inApproved = useMemo(
    () => (customer?.groups ?? []).some((g) => String(g?.name ?? "").toLowerCase() === APPROVED_GROUP_NAME),
    [customer]
  )
  const meta = customer?.metadata ?? {}
  const status = typeof meta.application_status === "string" ? meta.application_status : null
  const isDenied = status === "denied"
  const deniedAt = typeof meta.denied_at === "string" ? new Date(meta.denied_at) : null
  const previousReasonLabel = typeof meta.denial_reason_label === "string" ? meta.denial_reason_label : null
  const previousReasonId    = typeof meta.denial_reason_id === "string"    ? meta.denial_reason_id    : null
  const previousNote        = typeof meta.denial_operator_note === "string" ? meta.denial_operator_note : null

  const showForm = editing || (!isDenied && !inApproved)

  // Default the reason dropdown to whatever was previously denied with,
  // so a "change reason" click pre-selects the current one.
  useEffect(() => {
    if (!showForm) return
    if (!reasonId && previousReasonId && reasons.some((r) => r.id === previousReasonId)) {
      setReasonId(previousReasonId)
      if (previousNote && !note) setNote(previousNote)
    }
  }, [showForm, reasonId, previousReasonId, previousNote, note, reasons])

  // If the customer is approved, this widget is irrelevant.
  if (loading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Denial</Heading>
          <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
        </div>
      </Container>
    )
  }
  if (inApproved) return null

  const onSubmit = async () => {
    if (!reasonId) {
      toast.error("Pick a reason first")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${data.id}/deny-application`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reasonId, operatorNote: note }),
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        toast.error(json?.message ?? `Failed (${res.status})`)
        return
      }
      toast.success(json.emailSent ? `Denial email sent to ${json.email}` : `Denial saved (email skipped: ${json.message ?? "no provider"})`)
      setEditing(false)
      await refreshCustomer()
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <Heading level="h2">Denial</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {isDenied
                ? "Application was denied. You can change the reason and re-send the email if needed."
                : "Deny this wholesale application and email the applicant the reason."}
            </Text>
            {isDenied && deniedAt && (
              <Text size="small" className="text-ui-fg-muted mt-1">
                Denied: {deniedAt.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                {previousReasonLabel ? <> — <strong>{previousReasonLabel}</strong></> : null}
              </Text>
            )}
          </div>
          {isDenied && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Change reason / Re-send
            </Button>
          )}
        </div>

        {showForm && (
          <div className="flex flex-col gap-3 mt-4">
            <div>
              <Text size="xsmall" weight="plus" className="mb-1.5 block">Reason</Text>
              {reasons.length === 0 ? (
                <Text size="small" className="text-ui-fg-error">
                  No active reasons. Add some in MBS Settings → Denial Reasons.
                </Text>
              ) : (
                <Select value={reasonId} onValueChange={setReasonId}>
                  <Select.Trigger>
                    <Select.Value placeholder="Pick a reason…" />
                  </Select.Trigger>
                  <Select.Content>
                    {reasons.map((r) => (
                      <Select.Item key={r.id} value={r.id}>{r.label}</Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              )}
            </div>
            <div>
              <Text size="xsmall" weight="plus" className="mb-1.5 block">Note to applicant (optional)</Text>
              <Textarea
                rows={3}
                placeholder="e.g. Please re-apply once your DEA license renewal is complete."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="danger" onClick={onSubmit} isLoading={busy} disabled={!reasonId || reasons.length === 0}>
                {isDenied ? "Re-send Denial" : "Send Denial"}
              </Button>
              {editing && (
                <Button variant="transparent" onClick={() => { setEditing(false) }}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerDenyApplicationWidget

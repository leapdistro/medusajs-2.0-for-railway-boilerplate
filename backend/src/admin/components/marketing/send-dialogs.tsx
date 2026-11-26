import { Button, Input, Label, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { api, fmtDate, type Campaign, type MarketingCustomer } from "./api"
import { Modal } from "./modal"

export function TestDialog({ campaign, customers, onClose, onSent }: {
  campaign: Campaign; customers: MarketingCustomer[]; onClose: () => void; onSent: () => void
}) {
  const [to, setTo] = useState("")
  const [viewAs, setViewAs] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api<{ user?: { email?: string } }>("/admin/users/me").then((r) => { if (r.user?.email) setTo((v) => v || r.user!.email!) }).catch(() => {})
  }, [])
  const send = async () => {
    setBusy(true)
    try {
      const list = to.split(/[,\s]+/).filter(Boolean)
      await api(`/admin/marketing/campaigns/${campaign.id}/send-sample`, { body: { to: list, viewAs: viewAs || undefined } })
      toast.success(`Test sent to ${list.join(", ")}`)
      onSent()
      onClose()
    } catch (e: any) {
      toast.error(e?.message ?? "Test didn't send")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Send a test"
      subtitle="Only the addresses below get it, with [Test] in the subject."
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={send} isLoading={busy} disabled={!to.trim()}>Send test</Button></>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">Send to</Label>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@hempmbs.com" />
          <Text size="xsmall" className="text-ui-fg-muted">Up to 5, separated by commas.</Text>
        </div>
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">Show prices as</Label>
          <select value={viewAs} onChange={(e) => setViewAs(e.target.value)} className="rounded-md border border-ui-border-base bg-ui-bg-field px-2 py-2 txt-compact-small">
            <option value="">Default prices</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.company || c.name || c.email} ({c.pricingLabel})</option>)}
          </select>
        </div>
      </div>
    </Modal>
  )
}

/** Final check: summary + type the number of recipients (owner, 2026-11-25). */
export function SendDialog({ campaign, count, suppressed, onClose, onDone }: {
  campaign: Campaign; count: number; suppressed: number; onClose: () => void; onDone: () => void
}) {
  const [typed, setTyped] = useState("")
  const [when, setWhen] = useState<"now" | "later">("now")
  const [at, setAt] = useState("")
  const [busy, setBusy] = useState(false)
  const ok = Number(typed) === count && count > 0 && (when === "now" || !!at)
  const send = async () => {
    setBusy(true)
    try {
      const r = await api<{ status: string; scheduled_at?: string }>(`/admin/marketing/campaigns/${campaign.id}/send`, {
        body: { confirmCount: Number(typed), scheduledAt: when === "later" ? new Date(at).toISOString() : undefined },
      })
      toast.success(r.status === "scheduled" ? `Scheduled for ${fmtDate(r.scheduled_at)}` : `Sending to ${count} customers`)
      onDone()
      onClose()
    } catch (e: any) {
      toast.error(e?.message ?? "Didn't send")
    } finally {
      setBusy(false)
    }
  }
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex gap-3 py-1"><Text size="small" className="text-ui-fg-subtle" style={{ width: 110 }}>{k}</Text><Text size="small" weight="plus" style={{ flex: 1 }}>{v}</Text></div>
  )
  return (
    <Modal
      title="Send to customers"
      subtitle="This can't be undone once it starts."
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={send} isLoading={busy} disabled={!ok}>{when === "now" ? `Send to ${count}` : "Schedule"}</Button></>}
    >
      <div className="flex flex-col gap-4">
        <div>
          {row("Subject", campaign.subject)}
          {row("Recipients", `${count} approved customer${count === 1 ? "" : "s"}`)}
          {suppressed ? row("Left out", `${suppressed} unsubscribed or bounced`) : null}
          {row("Test", campaign.last_test_at ? `Last test sent ${fmtDate(campaign.last_test_at)}` : <span style={{ color: "var(--fg-error, #b91c1c)" }}>No test sent yet</span>)}
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-2"><input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /><Text size="small">Send now</Text></label>
          <label className="flex items-center gap-2"><input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /><Text size="small">Schedule</Text></label>
          {when === "later" ? <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="rounded-md border border-ui-border-base bg-ui-bg-field px-2 py-1 txt-compact-small" /> : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label size="small" weight="plus">Type {count} to confirm</Label>
          <Input value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder={String(count)} autoFocus />
        </div>
      </div>
    </Modal>
  )
}

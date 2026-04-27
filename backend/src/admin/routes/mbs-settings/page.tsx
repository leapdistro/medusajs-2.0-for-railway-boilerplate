import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Input, Label, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/* Inline gear SVG so we don't need to depend on @medusajs/icons. Sized
 * 20x20 to match the admin sidebar's other icons. */
const GearIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
)

/**
 * MBS Settings — central admin screen for every operator-editable system
 * value. Each tab edits one `system_setting` row by `key`.
 *
 * Schema per key (matches seed-settings.ts defaults):
 *   - payment_info        : { dba, mailing_address, bank: {...}, net_terms_default, memo_instruction }
 *   - contact_info        : { support_email, support_phone, hours }
 *   - cancellation_reasons: Array<{ id, label, archived }>
 *   - denial_reasons      : Array<{ id, label, archived }>
 *
 * The admin reads via GET /admin/mbs/settings (one fetch on mount), then
 * each tab POSTs back `{ key, value }` on Save. No optimistic UI — the
 * Save button shows a loading state and we wait for the round-trip.
 */

type SettingRow = { id: string; key: string; value: any; description?: string | null }

const TABS = [
  { id: "payment_info",         label: "Payment Info"          },
  { id: "contact_info",         label: "Contact Info"          },
  { id: "cancellation_reasons", label: "Cancellation Reasons"  },
  { id: "denial_reasons",       label: "Denial Reasons"        },
] as const
type TabId = typeof TABS[number]["id"]

async function saveSetting(key: string, value: unknown, description?: string): Promise<SettingRow | null> {
  const res = await fetch("/admin/mbs/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ key, value, description }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message ?? `Save failed (${res.status})`)
  }
  const json = await res.json()
  return json.setting ?? null
}

const MbsSettingsPage = () => {
  const [tab, setTab] = useState<TabId>("payment_info")
  const [rows, setRows] = useState<Record<string, SettingRow>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/admin/mbs/settings", { credentials: "include" })
      if (!res.ok) throw new Error(`Load failed (${res.status})`)
      const json = await res.json()
      const map: Record<string, SettingRow> = {}
      for (const r of (json.settings ?? []) as SettingRow[]) map[r.key] = r
      setRows(map)
    } catch (e: any) {
      setError(e?.message ?? "Network error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const onSaved = useCallback((row: SettingRow | null) => {
    if (!row) return
    setRows((p) => ({ ...p, [row.key]: row }))
  }, [])

  const currentRow = rows[tab]
  const description = currentRow?.description ?? ""

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">MBS Settings</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Operator-editable values used by emails, checkout, and admin flows.
        </Text>
      </div>

      <div className="flex gap-1 px-6 py-3 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors " +
              (tab === t.id
                ? "border-ui-fg-base text-ui-fg-base"
                : "border-transparent text-ui-fg-subtle hover:text-ui-fg-base")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-6 py-5 min-h-[400px]">
        {loading ? (
          <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
        ) : error ? (
          <Text size="small" className="text-ui-fg-error">{error}</Text>
        ) : (
          <>
            {description && (
              <Text size="small" className="text-ui-fg-subtle mb-4">{description}</Text>
            )}
            {tab === "payment_info" && (
              <PaymentInfoForm row={currentRow} onSaved={onSaved} />
            )}
            {tab === "contact_info" && (
              <ContactInfoForm row={currentRow} onSaved={onSaved} />
            )}
            {tab === "cancellation_reasons" && (
              <ReasonListForm row={currentRow} onSaved={onSaved} keyName="cancellation_reasons" />
            )}
            {tab === "denial_reasons" && (
              <ReasonListForm row={currentRow} onSaved={onSaved} keyName="denial_reasons" />
            )}
          </>
        )}
      </div>
    </Container>
  )
}

/* ─────────────────────────── Payment Info ─────────────────────────── */
type PaymentInfo = {
  dba: string
  mailing_address: string
  bank: {
    bank_name: string
    beneficiary_name: string
    routing_number: string
    account_number: string
    swift_code: string
    account_type: string
  }
  net_terms_default: string
  memo_instruction: string
}
const EMPTY_PAYMENT: PaymentInfo = {
  dba: "", mailing_address: "",
  bank: { bank_name: "", beneficiary_name: "", routing_number: "", account_number: "", swift_code: "", account_type: "checking" },
  net_terms_default: "", memo_instruction: "",
}

const PaymentInfoForm = ({ row, onSaved }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void }) => {
  const [v, setV] = useState<PaymentInfo>(EMPTY_PAYMENT)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (row?.value) setV({ ...EMPTY_PAYMENT, ...(row.value as PaymentInfo), bank: { ...EMPTY_PAYMENT.bank, ...(row.value as PaymentInfo).bank } }) }, [row])

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting("payment_info", v)
      onSaved(next)
      toast.success("Payment info saved")
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }
  const setBank = (k: keyof PaymentInfo["bank"]) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV((p) => ({ ...p, bank: { ...p.bank, [k]: e.target.value } }))

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <Field label="DBA (legal business name)">
        <Input value={v.dba} onChange={(e) => setV((p) => ({ ...p, dba: e.target.value }))} />
      </Field>
      <Field label="Mailing address (where checks go)">
        <Textarea rows={2} value={v.mailing_address} onChange={(e) => setV((p) => ({ ...p, mailing_address: e.target.value }))} />
      </Field>

      <div className="border-t pt-4">
        <Heading level="h3" className="mb-3">Bank / Wire info</Heading>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Bank name"><Input value={v.bank.bank_name} onChange={setBank("bank_name")} /></Field>
          <Field label="Beneficiary name"><Input value={v.bank.beneficiary_name} onChange={setBank("beneficiary_name")} /></Field>
          <Field label="Routing / ABA number"><Input value={v.bank.routing_number} onChange={setBank("routing_number")} /></Field>
          <Field label="Account number"><Input value={v.bank.account_number} onChange={setBank("account_number")} /></Field>
          <Field label="SWIFT (international)"><Input value={v.bank.swift_code} onChange={setBank("swift_code")} /></Field>
          <Field label="Account type"><Input value={v.bank.account_type} onChange={setBank("account_type")} /></Field>
        </div>
      </div>

      <Field label="Net Terms default text">
        <Textarea rows={2} value={v.net_terms_default} onChange={(e) => setV((p) => ({ ...p, net_terms_default: e.target.value }))} />
      </Field>
      <Field label="Memo instruction (shown to customers)">
        <Input value={v.memo_instruction} onChange={(e) => setV((p) => ({ ...p, memo_instruction: e.target.value }))} />
      </Field>

      <div>
        <Button variant="primary" onClick={save} isLoading={saving}>Save Payment Info</Button>
      </div>
    </div>
  )
}

/* ─────────────────────────── Contact Info ─────────────────────────── */
type ContactInfo = { support_email: string; support_phone: string; hours: string }
const EMPTY_CONTACT: ContactInfo = { support_email: "", support_phone: "", hours: "" }

const ContactInfoForm = ({ row, onSaved }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void }) => {
  const [v, setV] = useState<ContactInfo>(EMPTY_CONTACT)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (row?.value) setV({ ...EMPTY_CONTACT, ...(row.value as ContactInfo) }) }, [row])

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting("contact_info", v)
      onSaved(next)
      toast.success("Contact info saved")
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex flex-col gap-5 max-w-xl">
      <Field label="Support email"><Input type="email" value={v.support_email} onChange={(e) => setV((p) => ({ ...p, support_email: e.target.value }))} /></Field>
      <Field label="Support phone"><Input value={v.support_phone} onChange={(e) => setV((p) => ({ ...p, support_phone: e.target.value }))} /></Field>
      <Field label="Hours"><Input value={v.hours} onChange={(e) => setV((p) => ({ ...p, hours: e.target.value }))} /></Field>
      <div>
        <Button variant="primary" onClick={save} isLoading={saving}>Save Contact Info</Button>
      </div>
    </div>
  )
}

/* ──────────────────────── Reason List (shared) ──────────────────────── */
type Reason = { id: string; label: string; archived: boolean }

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

const ReasonListForm = ({ row, onSaved, keyName }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void; keyName: "cancellation_reasons" | "denial_reasons" }) => {
  const [items, setItems] = useState<Reason[]>([])
  const [newLabel, setNewLabel] = useState("")
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (Array.isArray(row?.value)) setItems(row.value as Reason[]) }, [row])

  const add = () => {
    const label = newLabel.trim()
    if (!label) return
    let id = slugify(label)
    let n = 1
    while (items.some((r) => r.id === id)) { id = `${slugify(label)}_${++n}` }
    setItems((p) => [...p, { id, label, archived: false }])
    setNewLabel("")
  }
  const updateLabel = (id: string, label: string) => setItems((p) => p.map((r) => r.id === id ? { ...r, label } : r))
  const toggleArchived = (id: string) => setItems((p) => p.map((r) => r.id === id ? { ...r, archived: !r.archived } : r))
  const remove = (id: string) => {
    if (!confirm("Remove this reason permanently? Past orders/applications referencing this id will keep showing the label, but it won't appear in the dropdown anymore.")) return
    setItems((p) => p.filter((r) => r.id !== id))
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting(keyName, items)
      onSaved(next)
      toast.success("Reasons saved")
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex flex-col gap-2">
        {items.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">No reasons yet — add one below.</Text>
        ) : items.map((r) => (
          <div key={r.id} className="flex items-center gap-2 border px-3 py-2">
            <Input
              value={r.label}
              onChange={(e) => updateLabel(r.id, e.target.value)}
              className="flex-1"
            />
            <Text size="xsmall" className="text-ui-fg-muted font-mono px-2">{r.id}</Text>
            <Button variant={r.archived ? "secondary" : "transparent"} size="small" onClick={() => toggleArchived(r.id)}>
              {r.archived ? "Archived" : "Active"}
            </Button>
            <Button variant="danger" size="small" onClick={() => remove(r.id)}>Remove</Button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t pt-4">
        <Input
          placeholder="New reason label…"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add() } }}
          className="flex-1"
        />
        <Button variant="secondary" onClick={add}>Add</Button>
      </div>

      <div>
        <Button variant="primary" onClick={save} isLoading={saving}>Save Reasons</Button>
      </div>
    </div>
  )
}

/* ─────────────────────────── Tiny atom ─────────────────────────── */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <Label size="xsmall" weight="plus">{label}</Label>
    {children}
  </div>
)

export const config = defineRouteConfig({
  label: "MBS Settings",
  icon: GearIcon,
})

export default MbsSettingsPage

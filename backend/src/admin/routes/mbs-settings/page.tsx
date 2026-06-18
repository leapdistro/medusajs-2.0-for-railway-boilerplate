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
  { id: "payment_info",            label: "Payment Info"            },
  { id: "contact_info",            label: "Contact Info"            },
  { id: "cancellation_reasons",    label: "Cancellation Reasons"    },
  { id: "denial_reasons",          label: "Denial Reasons"          },
  { id: "business_types",          label: "Business Types"          },
  { id: "flower_tier_prices",      label: "Flower Tier Prices"      },
  { id: "pre_roll_tier_prices",    label: "Pre-Roll Tier Prices"    },
  { id: "owner_markup",            label: "Owner Markup"            },
  { id: "flower_distro_prices",    label: "Flower Distro Prices"    },
  { id: "preroll_distro_prices",   label: "Pre-Roll Distro Prices"  },
  { id: "shipping_rates",          label: "Shipping Rates"          },
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
            {tab === "business_types" && (
              <ReasonListForm row={currentRow} onSaved={onSaved} keyName="business_types" />
            )}
            {tab === "flower_tier_prices" && (
              <TierPricesForm rows={rows} onSaved={onSaved} />
            )}
            {tab === "pre_roll_tier_prices" && (
              <PreRollTierPricesForm rows={rows} onSaved={onSaved} />
            )}
            {tab === "owner_markup" && (
              <OwnerMarkupForm rows={rows} onSaved={onSaved} />
            )}
            {tab === "flower_distro_prices" && (
              <DistroFlowerPricesForm row={currentRow} onSaved={onSaved} />
            )}
            {tab === "preroll_distro_prices" && (
              <DistroPreRollPricesForm row={currentRow} onSaved={onSaved} />
            )}
            {tab === "shipping_rates" && (
              <ShippingRatesForm row={currentRow} onSaved={onSaved} />
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

const ReasonListForm = ({ row, onSaved, keyName }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void; keyName: "cancellation_reasons" | "denial_reasons" | "business_types" }) => {
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

  /* "Reasons" → "Business Types" copy swap when this form is rendered
   * for the business_types tab. Same shape + behaviour underneath; just
   * makes the toast + button label honest. */
  const noun = keyName === "business_types" ? "Business Types" : "Reasons"

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting(keyName, items)
      onSaved(next)
      toast.success(`${noun} saved`)
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
        <Button variant="primary" onClick={save} isLoading={saving}>Save {noun}</Button>
      </div>
    </div>
  )
}

/* ─────────────────────── Tier Prices (Flower) ─────────────────────── */
type TierKey = "classic" | "exotic" | "super" | "snow" | "rapper"
type SizeKey = "qp" | "half" | "lb"
type TierPrices = Record<TierKey, Record<SizeKey, number>>

const TIER_ORDER: TierKey[] = ["classic", "exotic", "super", "snow", "rapper"]
const SIZE_ORDER: SizeKey[] = ["qp", "half", "lb"]
const TIER_LABELS: Record<TierKey, string> = {
  classic: "Classic",
  exotic:  "Exotic",
  super:   "Super",
  snow:    "Snow",
  rapper:  "Rapper",
}
const SIZE_LABELS: Record<SizeKey, string> = {
  qp:   "QP",
  half: "½",
  lb:   "LB",
}

const EMPTY_TIER_PRICES: TierPrices = {
  classic: { qp: 0, half: 0, lb: 0 },
  exotic:  { qp: 0, half: 0, lb: 0 },
  super:   { qp: 0, half: 0, lb: 0 },
  snow:    { qp: 0, half: 0, lb: 0 },
  rapper:  { qp: 0, half: 0, lb: 0 },
}

/* Pricing levels rendered inside the Flower / Pre-Roll Tier Prices
 * tabs. Default = the everyone-else tier prices written to the variant's
 * default USD row. tier_2 / tier_3 = customer-group-scoped PriceLists
 * (same machinery as Distro / Owner Stores). One "Save & Apply All"
 * button per tab writes all three settings + propagates all three
 * (default via tier-prices/apply, tier_2/tier_3 via group-prices/apply). */
const FLOWER_LEVELS = [
  { key: "default", title: "Default Tier Prices",    settingKey: "flower_tier_prices",   group: null     as null | "tier_2" | "tier_3" },
  { key: "tier_2",  title: "Chain of Stores",        settingKey: "flower_tier_2_prices", group: "tier_2" as null | "tier_2" | "tier_3" },
  { key: "tier_3",  title: "Low Volume",             settingKey: "flower_tier_3_prices", group: "tier_3" as null | "tier_2" | "tier_3" },
] as const

function readTierPrices(row?: SettingRow): TierPrices {
  if (!row?.value) return EMPTY_TIER_PRICES
  const incoming = row.value as Partial<TierPrices>
  return {
    classic: { ...EMPTY_TIER_PRICES.classic, ...(incoming.classic ?? {}) },
    exotic:  { ...EMPTY_TIER_PRICES.exotic,  ...(incoming.exotic  ?? {}) },
    super:   { ...EMPTY_TIER_PRICES.super,   ...(incoming.super   ?? {}) },
    snow:    { ...EMPTY_TIER_PRICES.snow,    ...(incoming.snow    ?? {}) },
    rapper:  { ...EMPTY_TIER_PRICES.rapper,  ...(incoming.rapper  ?? {}) },
  }
}

type ApplyLevelResult = {
  ok: boolean
  title: string
  propagated: number
  skipped: number
  error?: string
}
type Level = { key: string; title: string; settingKey: string; group: null | "tier_2" | "tier_3" }

/* Shared apply helper for both Flower and Pre-Roll tabs. Default level
 * → tier-prices/apply (writes to variant base USD price). tier_2 /
 * tier_3 → group-prices/apply (writes to customer-group-scoped PriceList).
 * Catches HTTP failures per-call so one bad level doesn't abort the
 * whole Save & Apply All. */
async function applyLevel(lvl: Level, scope: "flower" | "preroll"): Promise<ApplyLevelResult> {
  const url = lvl.group
    ? "/admin/mbs/settings/group-prices/apply"
    : "/admin/mbs/settings/tier-prices/apply"
  const body: { scope: string; group?: string } = { scope }
  if (lvl.group) body.group = lvl.group
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, title: lvl.title, propagated: 0, skipped: 0, error: j?.message ?? `HTTP ${res.status}` }
    }
    const s = j.summary ?? {}
    return {
      ok: true,
      title: lvl.title,
      propagated: (s.added ?? 0) + (s.updated ?? 0),
      skipped: s.skipped ?? 0,
    }
  } catch (e: any) {
    return { ok: false, title: lvl.title, propagated: 0, skipped: 0, error: e?.message ?? "network error" }
  }
}

const TierPricesForm = ({ rows, onSaved }: { rows: Record<string, SettingRow>; onSaved: (r: SettingRow | null) => void }) => {
  const [values, setValues] = useState<Record<string, TierPrices>>({
    default: EMPTY_TIER_PRICES,
    tier_2:  EMPTY_TIER_PRICES,
    tier_3:  EMPTY_TIER_PRICES,
  })
  const [busy, setBusy] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)

  useEffect(() => {
    setValues({
      default: readTierPrices(rows["flower_tier_prices"]),
      tier_2:  readTierPrices(rows["flower_tier_2_prices"]),
      tier_3:  readTierPrices(rows["flower_tier_3_prices"]),
    })
  }, [rows])

  const setCell = (levelKey: string, tier: TierKey, size: SizeKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseFloat(e.target.value)
    setValues((prev) => ({
      ...prev,
      [levelKey]: {
        ...prev[levelKey],
        [tier]: { ...prev[levelKey][tier], [size]: Number.isFinite(n) ? n : 0 },
      },
    }))
  }

  /* Save all three settings, then propagate all three in parallel. We
   * don't bail on partial failure — if Tier 2 apply fails but Tier 3
   * succeeds, we still want the Tier 3 prices live. Errors surface in
   * the toast with the failing level called out. */
  const saveAndApply = async () => {
    setBusy(true)
    setConfirmApply(false)
    try {
      /* Step 1 — persist all three settings rows. */
      const saved = await Promise.all(
        FLOWER_LEVELS.map((lvl) => saveSetting(lvl.settingKey, values[lvl.key])),
      )
      for (const row of saved) onSaved(row)

      /* Step 2 — propagate. Default → tier-prices/apply (writes to
       * variant default price row). tier_2 / tier_3 → group-prices/apply
       * (writes to customer-group-scoped PriceList). */
      const results = await Promise.all(
        FLOWER_LEVELS.map((lvl) => applyLevel(lvl, "flower")),
      )
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      if (failed.length === 0) {
        const summary = ok.map((r) => `${r.title}: ${r.propagated}↑ ${r.skipped}–`).join(" · ")
        toast.success(`Saved & applied · ${summary}`)
      } else {
        const failedNames = failed.map((f) => f.title).join(", ")
        toast.error(`Some applies failed: ${failedNames}. ${failed[0].error ?? ""}`)
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <Text size="small" className="text-ui-fg-subtle">
        Selling prices for Flower variants (USD whole dollars). The <strong>Default</strong> table is the price every approved buyer sees unless their Pricing Mode is set to Tier 2, Tier 3, Distro, or Owner Stores. <strong>Tier 2 / Tier 3</strong> are customer-group-scoped — only buyers assigned to those modes see them. One <em>Save &amp; Apply All</em> below writes all three settings and propagates them in one click.
      </Text>

      {FLOWER_LEVELS.map((lvl) => (
        <div key={lvl.key} className="flex flex-col gap-2">
          <Heading level="h3">{lvl.title}</Heading>
          <div className="border">
            <div className="grid grid-cols-4 border-b">
              <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Tier</div>
              {SIZE_ORDER.map((s) => (
                <div key={s} className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle text-center">{SIZE_LABELS[s]}</div>
              ))}
            </div>
            {TIER_ORDER.map((tier, idx) => (
              <div key={tier} className={`grid grid-cols-4${idx < TIER_ORDER.length - 1 ? " border-b" : ""}`}>
                <div className="px-3 py-2 font-medium text-sm flex items-center">{TIER_LABELS[tier]}</div>
                {SIZE_ORDER.map((size) => (
                  <div key={size} className="p-1.5">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={1}
                      value={values[lvl.key][tier][size] || ""}
                      onChange={setCell(lvl.key, tier, size)}
                      placeholder="0"
                      className="text-right"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3 pt-2 border-t">
        <Button variant="primary" onClick={() => setConfirmApply(true)} isLoading={busy}>
          Save &amp; Apply All
        </Button>
      </div>

      {confirmApply && (
        <div className="border border-ui-border-base bg-ui-bg-subtle p-4 flex flex-col gap-3">
          <Text size="small" weight="plus">Save all three tables and overwrite every matching flower variant?</Text>
          <Text size="small" className="text-ui-fg-subtle">
            Saves <strong>Default</strong>, <strong>Tier 2</strong>, and <strong>Tier 3</strong> settings, then propagates each. Default writes to the variant&apos;s base USD price; Tier 2 / Tier 3 write to customer-group-scoped PriceLists. Resolution walks metadata → category+SKU → category+title; unresolved variants are skipped. Per-variant manual edits in standard Medusa admin will be overwritten.
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={saveAndApply} isLoading={busy}>Yes, Save &amp; Apply</Button>
            <Button variant="secondary" onClick={() => setConfirmApply(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ──────────────────────── Pre-Roll Tier Prices ──────────────────────── */
/* Keyed by (subcategory slug → variant sizeKey → dollars). Subcategories
 * + their variants are LIVE-MERGED from the receiving profile endpoint
 * so adding a new Pre-Roll subcategory in Medusa makes it appear here
 * automatically with $0 defaults. Mirrors the shipping_rates pre-roll
 * pattern — same admin UX, just selling price instead of shipping. */
type PreRollTierPrices = Record<string, Record<string, number>>

const EMPTY_PREROLL_TIER_PRICES: PreRollTierPrices = {}

/* Pre-Roll levels — same shape as FLOWER_LEVELS but with the pre-roll
 * settings keys. Distro stays in its own tab; only Default + Tier 2 +
 * Tier 3 are stacked here per the latest UX decision. */
const PREROLL_LEVELS = [
  { key: "default", title: "Default Tier Prices",   settingKey: "pre_roll_tier_prices",  group: null     as null | "tier_2" | "tier_3" },
  { key: "tier_2",  title: "Chain of Stores",       settingKey: "preroll_tier_2_prices", group: "tier_2" as null | "tier_2" | "tier_3" },
  { key: "tier_3",  title: "Low Volume",            settingKey: "preroll_tier_3_prices", group: "tier_3" as null | "tier_2" | "tier_3" },
] as const

const PreRollTierPricesForm = ({ rows, onSaved }: { rows: Record<string, SettingRow>; onSaved: (r: SettingRow | null) => void }) => {
  const [values, setValues] = useState<Record<string, PreRollTierPrices>>({
    default: EMPTY_PREROLL_TIER_PRICES,
    tier_2:  EMPTY_PREROLL_TIER_PRICES,
    tier_3:  EMPTY_PREROLL_TIER_PRICES,
  })
  const [prerollSubs, setPrerollSubs] = useState<PrerollSubcategoryRow[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    setValues({
      default: { ...((rows["pre_roll_tier_prices"]?.value as PreRollTierPrices | undefined) ?? {}) },
      tier_2:  { ...((rows["preroll_tier_2_prices"]?.value as PreRollTierPrices | undefined) ?? {}) },
      tier_3:  { ...((rows["preroll_tier_3_prices"]?.value as PreRollTierPrices | undefined) ?? {}) },
    })
  }, [rows])

  useEffect(() => {
    let cancelled = false
    fetch("/admin/receiving/profile/pre-roll", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { profile?: { subcategories?: PrerollSubcategoryRow[] } }) => {
        if (cancelled) return
        setPrerollSubs(j.profile?.subcategories ?? [])
      })
      .catch((e: any) => {
        if (cancelled) return
        setLoadError(`Could not load pre-roll subcategories: ${e?.message}`)
      })
    return () => { cancelled = true }
  }, [])

  const setCell = (levelKey: string, subKey: string, sizeKey: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseFloat(e.target.value)
    setValues((prev) => ({
      ...prev,
      [levelKey]: {
        ...prev[levelKey],
        [subKey]: { ...(prev[levelKey][subKey] ?? {}), [sizeKey]: Number.isFinite(n) ? n : 0 },
      },
    }))
  }

  const saveAndApply = async () => {
    setBusy(true)
    setConfirmApply(false)
    try {
      const saved = await Promise.all(
        PREROLL_LEVELS.map((lvl) => saveSetting(lvl.settingKey, values[lvl.key])),
      )
      for (const row of saved) onSaved(row)

      const results = await Promise.all(
        PREROLL_LEVELS.map((lvl) => applyLevel(lvl, "preroll")),
      )
      const ok = results.filter((r) => r.ok)
      const failed = results.filter((r) => !r.ok)
      if (failed.length === 0) {
        const summary = ok.map((r) => `${r.title}: ${r.propagated}↑ ${r.skipped}–`).join(" · ")
        toast.success(`Saved & applied · ${summary}`)
      } else {
        const failedNames = failed.map((f) => f.title).join(", ")
        toast.error(`Some applies failed: ${failedNames}. ${failed[0].error ?? ""}`)
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <Text size="small" className="text-ui-fg-subtle">
        Selling prices for Pre-Roll variants (USD whole dollars). Subcategories live-merged from Medusa — add a new Pre-Roll subcategory and it appears here with $0 placeholders. The <strong>Default</strong> table is the price every approved buyer sees unless their Pricing Mode is set to Tier 2, Tier 3, Distro, or Owner Stores. <strong>Tier 2 / Tier 3</strong> are customer-group-scoped. One <em>Save &amp; Apply All</em> below propagates everything.
      </Text>

      {loadError ? (
        <Text size="small" className="text-ui-fg-error">{loadError}</Text>
      ) : prerollSubs.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">Loading pre-roll subcategories…</Text>
      ) : (
        PREROLL_LEVELS.map((lvl) => (
          <div key={lvl.key} className="flex flex-col gap-2">
            <Heading level="h3">{lvl.title}</Heading>
            <div className="border divide-y">
              {prerollSubs.map((sub) => (
                <div key={sub.key} className="px-3 py-3">
                  <Text size="small" weight="plus" className="mb-1.5">{sub.label}</Text>
                  <div className="flex flex-col gap-1.5">
                    {sub.variants.map((variant) => (
                      <div key={variant.sizeKey} className="grid grid-cols-2 gap-2 items-center">
                        <Text size="small" className="text-ui-fg-subtle">{variant.label}</Text>
                        <div className="flex items-center gap-1">
                          <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step={1}
                            value={values[lvl.key][sub.key]?.[variant.sizeKey] || ""}
                            onChange={setCell(lvl.key, sub.key, variant.sizeKey)}
                            placeholder="0"
                            className="text-right"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="flex items-center gap-3 pt-2 border-t">
        <Button variant="primary" onClick={() => setConfirmApply(true)} isLoading={busy}>
          Save &amp; Apply All
        </Button>
      </div>

      {confirmApply && (
        <div className="border border-ui-border-base bg-ui-bg-subtle p-4 flex flex-col gap-3">
          <Text size="small" weight="plus">Save all three tables and overwrite every matching pre-roll variant?</Text>
          <Text size="small" className="text-ui-fg-subtle">
            Saves <strong>Default</strong>, <strong>Tier 2</strong>, and <strong>Tier 3</strong> settings, then propagates each. Default writes to the variant&apos;s base USD price; Tier 2 / Tier 3 write to customer-group-scoped PriceLists. Resolution walks metadata → category+SKU → category+title; unresolved variants are skipped.
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={saveAndApply} isLoading={busy}>Yes, Save &amp; Apply</Button>
            <Button variant="secondary" onClick={() => setConfirmApply(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────── Owner Stores Markup ──────────────────────── */
/* Owner-stores buyers pay (landed cost + markup) × pool_units. This tab
 * just persists the markup numbers — propagation to a customer-group
 * price list lands in slice 4 (apply endpoint extension + receiving
 * subscriber). Two separate rows in mbs-settings: flower per QP unit,
 * pre-roll per box. */
const OwnerMarkupForm = ({ rows, onSaved }: { rows: Record<string, SettingRow>; onSaved: (r: SettingRow | null) => void }) => {
  const [flower, setFlower] = useState<number>(0)
  const [preroll, setPreroll] = useState<number>(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const f = rows["flower_owner_markup_per_qp"]?.value
    const p = rows["preroll_owner_markup_per_box"]?.value
    if (typeof f === "number") setFlower(f)
    if (typeof p === "number") setPreroll(p)
  }, [rows])

  const save = async () => {
    setSaving(true)
    try {
      const a = await saveSetting("flower_owner_markup_per_qp", flower)
      const b = await saveSetting("preroll_owner_markup_per_box", preroll)
      onSaved(a)
      onSaved(b)
      /* Auto-Apply on Save — the markup is the sole input to the
       * computed price, so saving it without applying leaves the
       * PriceList stale until the operator clicks Apply. Running
       * both scopes inline removes the two-button trap. */
      const [fr, pr] = await Promise.all([
        applyScope("flower"),
        applyScope("preroll"),
      ])
      const total = fr.propagated + pr.propagated
      const skipped = fr.skipped + pr.skipped
      toast.success(`Owner markup saved · ${total} prices propagated · ${skipped} skipped`)
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }

  /* Shared apply helper — used by Save (auto-apply) AND the explicit
   * Apply buttons. Returns the propagated/skipped counts so the
   * caller can roll them into its own toast. Throws on HTTP error so
   * Save's try/catch surfaces the failure. */
  const applyScope = async (scope: "flower" | "preroll"): Promise<{ propagated: number; skipped: number }> => {
    const res = await fetch("/admin/mbs/settings/owner-prices/apply", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.message ?? `Apply (${scope}) failed (${res.status})`)
    const s = body.summary ?? {}
    return {
      propagated: (s.added ?? 0) + (s.updated ?? 0),
      skipped: s.skipped ?? 0,
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <Text size="small" className="text-ui-fg-subtle">
        Markup added on top of landed cost for buyers in the <strong>owner_stores</strong> customer group. Flower markup is per QP unit (Half = 2×, LB = 4×). Pre-roll markup is per box. Save propagates computed prices to a customer-group-scoped PriceList automatically.
      </Text>

      <div className="border divide-y">
        <div className="grid grid-cols-2 items-center px-3 py-3 gap-3">
          <Text size="small" weight="plus">Flower — per QP</Text>
          <div className="flex items-center gap-1">
            <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={flower || ""}
              onChange={(e) => setFlower(Number.isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0)}
              placeholder="0"
              className="text-right"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 items-center px-3 py-3 gap-3">
          <Text size="small" weight="plus">Pre-Roll — per box</Text>
          <div className="flex items-center gap-1">
            <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={preroll || ""}
              onChange={(e) => setPreroll(Number.isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0)}
              placeholder="0"
              className="text-right"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2 border-t">
        <Button variant="primary" onClick={save} isLoading={saving}>Save Markup</Button>
      </div>
    </div>
  )
}

/* ───────────────────── Distro Pricing — Flower ───────────────────── */
/* Mirror of TierPricesForm but writes to flower_distro_prices. Apply
 * button comes online once slice 4 extends /tier-prices/apply to handle
 * the distro scope (which writes to a customer-group-scoped price list
 * instead of the variant's default price). */
const DistroFlowerPricesForm = ({ row, onSaved }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void }) => {
  const [v, setV] = useState<TierPrices>(EMPTY_TIER_PRICES)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!row?.value) return
    const incoming = row.value as Partial<TierPrices>
    setV({
      classic: { ...EMPTY_TIER_PRICES.classic, ...(incoming.classic ?? {}) },
      exotic:  { ...EMPTY_TIER_PRICES.exotic,  ...(incoming.exotic  ?? {}) },
      super:   { ...EMPTY_TIER_PRICES.super,   ...(incoming.super   ?? {}) },
      snow:    { ...EMPTY_TIER_PRICES.snow,    ...(incoming.snow    ?? {}) },
      rapper:  { ...EMPTY_TIER_PRICES.rapper,  ...(incoming.rapper  ?? {}) },
    })
  }, [row])

  const setCell = (tier: TierKey, size: SizeKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseFloat(e.target.value)
    setV((p) => ({ ...p, [tier]: { ...p[tier], [size]: Number.isFinite(n) ? n : 0 } }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting("flower_distro_prices", v)
      onSaved(next)
      /* Auto-Apply — saved table IS the price source. */
      const res = await fetch("/admin/mbs/settings/group-prices/apply", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "flower", group: "distro" }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.message ?? `Apply failed (${res.status})`)
      const s = body.summary ?? {}
      const propagated = (s.added ?? 0) + (s.updated ?? 0)
      toast.success(`Distro prices saved · ${propagated} propagated · ${s.skipped ?? 0} skipped`)
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <Text size="small" className="text-ui-fg-subtle">
        Selling prices for Flower variants shown to buyers in the <strong>distro</strong> customer group (USD whole dollars). Save propagates these to a customer-group-scoped Medusa PriceList automatically — buyers outside the group are unaffected.
      </Text>

      <div className="border">
        <div className="grid grid-cols-4 border-b">
          <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Tier</div>
          {SIZE_ORDER.map((s) => (
            <div key={s} className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle text-center">{SIZE_LABELS[s]}</div>
          ))}
        </div>
        {TIER_ORDER.map((tier, idx) => (
          <div key={tier} className={`grid grid-cols-4${idx < TIER_ORDER.length - 1 ? " border-b" : ""}`}>
            <div className="px-3 py-2 font-medium text-sm flex items-center">{TIER_LABELS[tier]}</div>
            {SIZE_ORDER.map((size) => (
              <div key={size} className="p-1.5">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={1}
                  value={v[tier][size] || ""}
                  onChange={setCell(tier, size)}
                  placeholder="0"
                  className="text-right"
                />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t">
        <Button variant="primary" onClick={save} isLoading={saving}>Save Distro Prices</Button>
      </div>
    </div>
  )
}

/* ───────────────────── Distro Pricing — Pre-Roll ───────────────────── */
const DistroPreRollPricesForm = ({ row, onSaved }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void }) => {
  const [v, setV] = useState<PreRollTierPrices>(EMPTY_PREROLL_TIER_PRICES)
  const [prerollSubs, setPrerollSubs] = useState<PrerollSubcategoryRow[]>([])
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!row?.value) return
    setV({ ...(row.value as PreRollTierPrices) })
  }, [row])

  useEffect(() => {
    let cancelled = false
    fetch("/admin/receiving/profile/pre-roll", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { profile?: { subcategories?: PrerollSubcategoryRow[] } }) => {
        if (cancelled) return
        setPrerollSubs(j.profile?.subcategories ?? [])
      })
      .catch((e: any) => {
        if (cancelled) return
        setLoadError(`Could not load pre-roll subcategories: ${e?.message}`)
      })
    return () => { cancelled = true }
  }, [])

  const setCell = (subKey: string, sizeKey: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseFloat(e.target.value)
    setV((p) => ({
      ...p,
      [subKey]: { ...(p[subKey] ?? {}), [sizeKey]: Number.isFinite(n) ? n : 0 },
    }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting("preroll_distro_prices", v)
      onSaved(next)
      /* Auto-Apply — saved table IS the price source. */
      const res = await fetch("/admin/mbs/settings/group-prices/apply", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "preroll", group: "distro" }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.message ?? `Apply failed (${res.status})`)
      const s = body.summary ?? {}
      const propagated = (s.added ?? 0) + (s.updated ?? 0)
      toast.success(`Pre-roll distro prices saved · ${propagated} propagated · ${s.skipped ?? 0} skipped`)
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <Text size="small" className="text-ui-fg-subtle">
        Selling prices for Pre-Roll variants shown to buyers in the <strong>distro</strong> customer group. Subcategories live-merged from Medusa — add a new Pre-Roll subcategory and it appears here. Save propagates these to a customer-group-scoped Medusa PriceList automatically — buyers outside the group are unaffected.
      </Text>

      {loadError ? (
        <Text size="small" className="text-ui-fg-error">{loadError}</Text>
      ) : prerollSubs.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">Loading pre-roll subcategories…</Text>
      ) : (
        <div className="border divide-y">
          {prerollSubs.map((sub) => (
            <div key={sub.key} className="px-3 py-3">
              <Text size="small" weight="plus" className="mb-1.5">{sub.label}</Text>
              <div className="flex flex-col gap-1.5">
                {sub.variants.map((variant) => (
                  <div key={variant.sizeKey} className="grid grid-cols-2 gap-2 items-center">
                    <Text size="small" className="text-ui-fg-subtle">{variant.label}</Text>
                    <div className="flex items-center gap-1">
                      <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={1}
                        value={v[sub.key]?.[variant.sizeKey] || ""}
                        onChange={setCell(sub.key, variant.sizeKey)}
                        placeholder="0"
                        className="text-right"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2 border-t">
        <Button variant="primary" onClick={save} isLoading={saving}>Save Pre-Roll Distro Prices</Button>
      </div>
    </div>
  )
}

/* ─────────────────────────── Shipping Rates ─────────────────────────── */
type ShippingRates = {
  flower: { qp: number; half: number; lb: number }
  preroll: Record<string, Record<string, number>>
}

type PrerollSubcategoryRow = {
  key: string
  label: string
  variants: Array<{ sizeKey: string; label: string }>
}

const EMPTY_SHIPPING_RATES: ShippingRates = {
  flower: { qp: 0, half: 0, lb: 0 },
  preroll: {},
}

const ShippingRatesForm = ({ row, onSaved }: { row?: SettingRow; onSaved: (r: SettingRow | null) => void }) => {
  const [v, setV] = useState<ShippingRates>(EMPTY_SHIPPING_RATES)
  const [prerollSubs, setPrerollSubs] = useState<PrerollSubcategoryRow[]>([])
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!row?.value) return
    const incoming = row.value as Partial<ShippingRates>
    setV({
      flower: { ...EMPTY_SHIPPING_RATES.flower, ...(incoming.flower ?? {}) },
      preroll: { ...(incoming.preroll ?? {}) },
    })
  }, [row])

  useEffect(() => {
    let cancelled = false
    fetch("/admin/receiving/profile/pre-roll", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { profile?: { subcategories?: PrerollSubcategoryRow[] } }) => {
        if (cancelled) return
        setPrerollSubs(j.profile?.subcategories ?? [])
      })
      .catch((e: any) => {
        if (cancelled) return
        setLoadError(`Could not load pre-roll subcategories: ${e?.message}`)
      })
    return () => { cancelled = true }
  }, [])

  const setFlower = (key: "qp" | "half" | "lb") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseFloat(e.target.value)
    setV((p) => ({ ...p, flower: { ...p.flower, [key]: Number.isFinite(n) ? n : 0 } }))
  }

  const setPreroll = (subKey: string, sizeKey: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = parseFloat(e.target.value)
    setV((p) => ({
      ...p,
      preroll: {
        ...p.preroll,
        [subKey]: { ...(p.preroll[subKey] ?? {}), [sizeKey]: Number.isFinite(n) ? n : 0 },
      },
    }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const next = await saveSetting("shipping_rates", v)
      onSaved(next)
      toast.success("Shipping rates saved")
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const apply = async () => {
    setApplying(true)
    setConfirmApply(false)
    try {
      /* Endpoint path is /shipping-weights/apply for historical reasons;
       * the handler reads shipping_rates and writes cents to variant.weight. */
      const res = await fetch("/admin/mbs/settings/shipping-weights/apply", {
        method: "POST",
        credentials: "include",
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.message ?? `Apply failed (${res.status})`)
      const s = body.summary ?? {}
      toast.success(
        `${s.updated ?? 0} variants updated · ${s.skipped ?? 0} skipped`,
      )
    } catch (e: any) {
      toast.error(e?.message ?? "Apply failed")
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <Text size="small" className="text-ui-fg-subtle">
        Flat shipping cost (USD) per variant size. Checkout sums rate × quantity across the cart to compute the buyer&apos;s total shipping. New variants created via receiving auto-stamp these values. Click <strong>Apply to All Variants</strong> after saving to overwrite existing variants in bulk.
      </Text>

      {/* Flower section */}
      <div>
        <Heading level="h2" className="mb-2">Flower</Heading>
        <div className="border">
          <div className="grid grid-cols-3 border-b">
            {(["qp", "half", "lb"] as const).map((k) => (
              <div key={k} className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle text-center">
                {k === "qp" ? "QP" : k === "half" ? "½" : "LB"}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3">
            {(["qp", "half", "lb"] as const).map((k) => (
              <div key={k} className="p-1.5 flex items-center gap-1">
                <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={1}
                  value={v.flower[k] || ""}
                  onChange={setFlower(k)}
                  placeholder="0"
                  className="text-right"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Pre-roll section */}
      <div>
        <Heading level="h2" className="mb-2">Pre-Rolls</Heading>
        {loadError ? (
          <Text size="small" className="text-ui-fg-error">{loadError}</Text>
        ) : prerollSubs.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">Loading pre-roll subcategories…</Text>
        ) : (
          <div className="border divide-y">
            {prerollSubs.map((sub) => (
              <div key={sub.key} className="px-3 py-3">
                <Text size="small" weight="plus" className="mb-1.5">{sub.label}</Text>
                <div className="flex flex-col gap-1.5">
                  {sub.variants.map((variant) => (
                    <div key={variant.sizeKey} className="grid grid-cols-2 gap-2 items-center">
                      <Text size="small" className="text-ui-fg-subtle">{variant.label}</Text>
                      <div className="flex items-center gap-1">
                        <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={1}
                          value={v.preroll[sub.key]?.[variant.sizeKey] || ""}
                          onChange={setPreroll(sub.key, variant.sizeKey)}
                          placeholder="0"
                          className="text-right"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 pt-2 border-t">
        <Button variant="primary" onClick={save} isLoading={saving}>Save Shipping Rates</Button>
        <Button variant="secondary" onClick={() => setConfirmApply(true)} isLoading={applying}>
          Apply to All Variants
        </Button>
      </div>

      {confirmApply && (
        <div className="border border-ui-border-base bg-ui-bg-subtle p-4 flex flex-col gap-3">
          <Text size="small" weight="plus">Overwrite every matching variant?</Text>
          <Text size="small" className="text-ui-fg-subtle">
            This will set the shipping rate on every flower + pre-roll variant whose tier_key / size_key matches the saved rates. Any per-variant overrides will be replaced. Variants without matching settings (custom subcategories not yet rated, or non-flower / non-pre-roll products) are skipped silently.
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={apply} isLoading={applying}>Yes, Apply</Button>
            <Button variant="secondary" onClick={() => setConfirmApply(false)} disabled={applying}>Cancel</Button>
          </div>
        </div>
      )}
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

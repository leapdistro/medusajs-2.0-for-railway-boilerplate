import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Checkbox, Container, Heading, Input, Label, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useColumnWidths } from "../../lib/resizable-columns"
import { CANNABINOIDS, cannabinoidField, otherCannabinoidColumns } from "../../lib/cannabinoids"
import {
  BulkCoaDropzone, BulkSelect, CheckBox, CoaAiButton, CoaUpload, DraftCard, Field, SaveStatusPill, Td, Th,
  formatRelativeTime, type CoaState, type DraftRow, type SaveRowResult,
} from "../../components/receiving-parts"
import { VendorPicker, supplierReady, useQboVendors, type SupplierFields } from "../../components/vendor-picker"

/**
 * Receiving for every category (Phase 4c). One spreadsheet, built from
 * the Flower receiving page, whose columns come from the category's
 * settings in MBS Settings → Categories: strain type, best for,
 * effects, the main cannabinoid and its "also record" ones, COA, UPC,
 * the receiving unit and a sell price for "price typed on each row"
 * categories. Invoice upload is offered when the category has it on;
 * otherwise rows are typed in.
 *
 * Saves through /admin/receiving/save. Replaced the Flower and
 * Pre-Rolls pages (4e); their old addresses redirect here.
 *
 * Opened at /app/receiving?key=<profile key>.
 */

const TruckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7V8z" />
    <circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
)

/* ---------- Category settings, as /admin/receiving/profile/:key returns them ---------- */
type Unit = { singular: string; plural: string }
type Variant = { sizeKey: string; label: string }
type Profile = {
  key: string
  displayName: string
  archived?: boolean
  subcategories: Array<{ key: string; label: string; variants?: Variant[] }>
  variants: Variant[]
  fields: { strainType: boolean; bestFor: boolean; effects: boolean; cannabinoids: boolean; coaRequired: boolean; upc: boolean }
  pricingModel: "tier" | "flat"
  tierPricesSettingKey?: string
  inputUnitLabel: Unit
  primaryCannabinoid?: string
  otherCannabinoids?: Array<{ cannabinoid: string; required: boolean }>
  invoiceUpload?: boolean
}
type ProfileListItem = Pick<Profile, "key" | "displayName" | "archived" | "primaryCannabinoid">

const STRAIN_TYPE_OPTIONS = ["Indica", "Sativa", "Hybrid"] as const
type StrainType = typeof STRAIN_TYPE_OPTIONS[number]
const BEST_FOR_OPTIONS = [
  { key: "day", label: "Day" },
  { key: "evening", label: "Evening" },
  { key: "night", label: "Night" },
] as const
type BestFor = typeof BEST_FOR_OPTIONS[number]["key"]
const EFFECT_OPTIONS = [
  "Chill", "Energy", "Relief", "Sleep", "Focus",
  "Grounded", "Creative", "Social", "Calm",
] as const
const MAX_EFFECTS = 2

/* Sativa→day, Hybrid→evening, Indica→night, as the old Flower page did. */
const TYPE_TO_BEST_FOR: Record<StrainType, BestFor> = { Sativa: "day", Hybrid: "evening", Indica: "night" }

/* ---------- Invoice (matches server-side ai-extraction.ts) ---------- */
type Supplier = SupplierFields
type Invoice = {
  supplier: Supplier
  invoiceNumber: string
  invoiceDate: string
  /* Quantities and prices are in the category's receiving unit; the
   * reader keeps the lb names. */
  lineItems: Array<{ strainName: string; quantityLb: number; unitPricePerLb: number; strainType: StrainType | null }>
  shippingTotal: number
  subtotal: number | null
  total: number
  notes: string | null
}
const blankInvoice = (): Invoice => ({
  supplier: { name: "", phone: null, email: null, address: null },
  invoiceNumber: "",
  invoiceDate: new Date().toISOString().slice(0, 10),
  lineItems: [],
  shippingTotal: 0,
  subtotal: null,
  total: 0,
  notes: null,
})

type NearMatch = { handle: string; title: string; tier: string; distance: number }
type Classification = {
  restock: { productId: string; handle: string; title: string; tier: string } | null
  tierConflict: { productId: string; handle: string; title: string; tier: string } | null
  near: NearMatch[]
}

/* One receiving row. Fields a category doesn't ask for stay empty and
 * aren't sent. */
type Row = {
  strainName: string
  quantity: number
  unitPrice: number
  /* Only for categories priced per row ("flat"). */
  sellPrice: number
  subcategory: string | null
  strainType: StrainType | null
  bestFor: BestFor | null
  effects: string[]
  coa: CoaState
  mainPercent: string
  otherPercents: Record<string, string>
  totalCannabinoidsPercent: string
  batchId: string
  upc: string
  coaNotes: string | null
  nearMatches: NearMatch[]
  classification: Classification | null
  confirmedTierConflict: boolean
}
const blankRow = (subcategory: string | null = null): Row => ({
  strainName: "",
  quantity: 0,
  unitPrice: 0,
  sellPrice: 0,
  subcategory,
  strainType: null,
  bestFor: null,
  effects: [],
  coa: { state: "idle" },
  mainPercent: "",
  otherPercents: {},
  totalCannabinoidsPercent: "",
  batchId: "",
  upc: "",
  coaNotes: null,
  nearMatches: [],
  classification: null,
  confirmedTierConflict: false,
})

/* ---------- Drafts ----------
 * This page's drafts are kind "cat:<key>". Drafts the Flower and
 * Pre-Rolls pages saved (kind "<key>") are listed too and converted on
 * resume; updating one moves it to this page. */
type Draft = { v: 2; invoice: Invoice; fileName: string; tokens: { in: number; out: number }; fromInvoice: boolean; rows: Row[] }
const draftKind = (key: string) => `cat:${key}`

function fromOldDraft(payload: any): Draft {
  if (payload?.v === 2) return payload as Draft
  const oldOthers = (r: any) => r.otherPercents ?? Object.fromEntries(
    [["D9", r.d9Percent], ["THC-A", r.thcaPercent]].filter(([, v]) => v),
  )
  const oldCoa = (c: any): CoaState => c?.state === "ready" ? c : { state: "idle" }
  /* Pre-Rolls page: header fields at the top, rows in boxes. */
  if (payload?.supplier && !payload?.invoice) {
    return {
      v: 2,
      invoice: {
        ...blankInvoice(),
        supplier: {
          name: payload.supplier.name ?? "",
          phone: payload.supplier.phone || null,
          email: payload.supplier.email || null,
          address: payload.supplier.address || null,
          qboVendorId: payload.supplier.qboVendorId ?? null,
        },
        invoiceNumber: payload.invoiceNumber ?? "",
        invoiceDate: payload.invoiceDate ?? blankInvoice().invoiceDate,
        shippingTotal: payload.shippingTotal ?? 0,
      },
      fileName: "Manual Entry",
      tokens: { in: 0, out: 0 },
      fromInvoice: false,
      rows: (payload.rows ?? []).map((r: any): Row => ({
        ...blankRow(r.subcategory || null),
        strainName: r.strainName ?? "",
        quantity: r.quantityBoxes ?? 0,
        unitPrice: r.costPerBox ?? 0,
        sellPrice: r.sellPricePerBox ?? 0,
        strainType: r.strainType || null,
        bestFor: r.bestFor || null,
        effects: r.effects ?? [],
        coa: oldCoa(r.coa),
        mainPercent: r.mainPercent ?? r.cbdPercent ?? "",
        otherPercents: oldOthers(r),
        totalCannabinoidsPercent: r.totalCannabinoidsPercent ?? "",
        batchId: r.batchId ?? "",
        upc: r.upc ?? "",
      })),
    }
  }
  /* Flower page: the invoice plus rows in lb. */
  return {
    v: 2,
    invoice: payload?.invoice ?? blankInvoice(),
    fileName: payload?.fileName ?? "Draft",
    tokens: payload?.tokens ?? { in: 0, out: 0 },
    fromInvoice: (payload?.tokens?.in ?? 0) > 0,
    rows: (payload?.rows ?? []).map((r: any): Row => ({
      ...blankRow(r.tier ?? null),
      strainName: r.strainName ?? "",
      quantity: r.quantityLb ?? 0,
      unitPrice: r.unitPricePerLb ?? 0,
      strainType: r.strainType ?? null,
      bestFor: r.bestFor ?? null,
      effects: r.effects ?? [],
      coa: r.coa ?? { state: "idle" },
      mainPercent: r.thcaPercent ?? "",
      otherPercents: oldOthers(r),
      totalCannabinoidsPercent: r.totalCannabinoidsPercent ?? "",
      batchId: r.batchId ?? "",
      coaNotes: r.coaNotes ?? null,
      confirmedTierConflict: !!r.confirmedTierConflict,
    })),
  }
}

/* ---------- Helpers ---------- */
const fmtMoney = (n: number) => `$${n.toFixed(2)}`
const fmtMoneyWhole = (n: number) => `$${Math.round(n).toLocaleString()}`

/* ---- Preview save: what /admin/receiving/save would do (preview: true) ---- */

type PreviewResult = {
  strainName: string
  tierLabel?: string
  action: "would-create" | "would-restock" | "failed" | "already-saved" | "not-saved"
  productHandle?: string
  baseSku?: string
  poolUnitLabel?: string
  landedPerQp: number
  error?: string
  preview?: {
    stockBefore: number | null
    stockAfter: number
    landedBefore: number | null
    variants?: Array<{ label: string; sku: string; price: number | null }>
    attributeChanges?: Array<{ field: string; from: unknown; to: unknown }>
  }
}

/* Stored attribute name → the column it comes from on this page. The
 * cannabinoid ones derive from the cannabinoid list (cbdPercent →
 * cbd_percent). */
const ATTRIBUTE_LABELS: Record<string, string> = {
  strain_type: "Type",
  best_for: "Best For",
  effects: "Effects",
  total_cannabinoids_percent: "Cann %",
  coa_url: "COA",
  batch_id: "Batch ID",
  ...Object.fromEntries(CANNABINOIDS.map((c) => {
    const f = cannabinoidField(c)
    return [f.rowField.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), f.label]
  })),
}
const showValue = (v: unknown) =>
  v == null || v === "" ? "—" : Array.isArray(v) ? (v.length ? v.join(", ") : "—") : String(v)

function PreviewPanel({ results, stale, unitLabel, onClose }: {
  results: PreviewResult[]
  stale: boolean
  unitLabel: string
  onClose: () => void
}) {
  const count = (a: PreviewResult["action"]) => results.filter((r) => r.action === a).length
  const failed = count("failed")
  const border = failed > 0 ? "#B91C1C" : "#0A0A0A"
  const cell = { padding: "6px 8px", borderTop: "1px solid #E5E1D6", verticalAlign: "top" as const, fontSize: 13 }
  return (
    <div style={{ border: `1.5px solid ${border}`, background: "#fff", padding: 16 }}>
      <div className="flex justify-between items-start gap-4">
        <div>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em", color: border }}>
            Preview · nothing saved
          </Text>
          <Text size="small">
            {count("would-create")} new · {count("would-restock")} restock
            {count("already-saved") > 0 && <> · {count("already-saved")} already saved on this invoice</>}
            {failed > 0 && <> · <span style={{ color: "#B91C1C" }}>{failed} would fail, so Save would save nothing</span></>}
          </Text>
          {stale && (
            <Text size="small" style={{ color: "#C98A00" }}>Out of date: the receiving changed since this preview. Preview again.</Text>
          )}
        </div>
        <Button variant="transparent" size="small" onClick={onClose}>Close</Button>
      </div>
      <div style={{ overflowX: "auto", marginTop: 12, opacity: stale ? 0.5 : 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", fontFamily: "monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              <th style={{ padding: "6px 8px" }}>Row</th>
              <th style={{ padding: "6px 8px" }}>Would</th>
              <th style={{ padding: "6px 8px" }}>Product</th>
              <th style={{ padding: "6px 8px" }}>Stock</th>
              <th style={{ padding: "6px 8px" }}>Landed / unit</th>
              <th style={{ padding: "6px 8px" }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const p = r.preview
              const pool = r.poolUnitLabel ?? unitLabel
              return (
                <tr key={i}>
                  <td style={cell}>{i + 1}. {r.strainName}{r.tierLabel ? <span className="text-ui-fg-muted"> · {r.tierLabel}</span> : null}</td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    {r.action === "would-create" && <Badge color="green" size="2xsmall">New product</Badge>}
                    {r.action === "would-restock" && <Badge color="blue" size="2xsmall">Restock</Badge>}
                    {r.action === "already-saved" && <Badge color="grey" size="2xsmall">Already saved</Badge>}
                    {r.action === "not-saved" && <Badge color="grey" size="2xsmall">OK</Badge>}
                    {r.action === "failed" && <Badge color="red" size="2xsmall">Would fail</Badge>}
                  </td>
                  <td style={{ ...cell, fontFamily: "monospace", fontSize: 12 }}>
                    {r.productHandle ?? "—"}{r.baseSku && <div className="text-ui-fg-muted">{r.baseSku}</div>}
                  </td>
                  <td style={{ ...cell, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {p ? <>{p.stockBefore ?? 0} → {p.stockAfter} {pool}</> : "—"}
                  </td>
                  <td style={{ ...cell, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {p ? <>{p.landedBefore != null ? `${fmtMoney(p.landedBefore)} → ` : ""}{fmtMoney(r.landedPerQp)} / {pool}</> : "—"}
                  </td>
                  <td style={cell}>
                    {r.action === "failed" && <span style={{ color: "#B91C1C" }}>{r.error}</span>}
                    {r.action === "already-saved" && <span className="text-ui-fg-muted">This invoice already saved it; Save skips it.</span>}
                    {p?.variants && (
                      <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                        {p.variants.map((v) => `${v.label} ${v.sku} ${v.price != null ? fmtMoney(v.price) : "no price"}`).join(" · ")}
                      </span>
                    )}
                    {p?.attributeChanges && (p.attributeChanges.length === 0
                      ? <span className="text-ui-fg-muted">No detail changes</span>
                      : p.attributeChanges.map((c) => (
                        <div key={c.field}>
                          {ATTRIBUTE_LABELS[c.field] ?? c.field}: {c.field === "coa_url"
                            ? (c.from ? "replaced with this COA" : "added")
                            : <>{showValue(c.from)} → {showValue(c.to)}</>}
                        </div>
                      )))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
type TierPrices = Record<string, Record<string, number>>

const readKeyFromUrl = () => {
  try { return new URLSearchParams(window.location.search).get("key") } catch { return null }
}
const writeKeyToUrl = (key: string) => {
  try {
    const u = new URL(window.location.href)
    u.searchParams.set("key", key)
    window.history.replaceState(null, "", u.toString())
  } catch { /* the page still works without it */ }
}

/* =========================================================
 * Page shell: category picker, then upload / review
 * ========================================================= */
const CategoryReceivingPage = () => {
  const [list, setList] = useState<ProfileListItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(() => readKeyFromUrl())
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [tierPrices, setTierPrices] = useState<TierPrices | null>(null)
  const [draft, setDraft] = useState<(Draft & { draftId: string | null }) | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/admin/mbs/category-profiles", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const items = ((j?.profiles ?? []) as ProfileListItem[]).filter((p) => !p.archived)
        setList(items)
        setSelectedKey((cur) => (cur && items.some((p) => p.key === cur) ? cur : items[0]?.key ?? null))
      })
      .catch((e) => { if (!cancelled) setListError(e?.message ?? "Couldn't load categories") })
    return () => { cancelled = true }
  }, [])

  /* The selected category's settings, with its live Medusa sub-categories. */
  useEffect(() => {
    let cancelled = false
    setProfile(null)
    setProfileError(null)
    setTierPrices(null)
    if (!selectedKey) return
    writeKeyToUrl(selectedKey)
    fetch(`/admin/receiving/profile/${encodeURIComponent(selectedKey)}`, { credentials: "include" })
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
        if (!cancelled) setProfile(j.profile as Profile)
        const settingKey = (j.profile as Profile).pricingModel === "tier" ? (j.profile as Profile).tierPricesSettingKey : undefined
        if (!settingKey) return
        const s = await fetch("/admin/mbs/settings", { credentials: "include" }).then((x) => x.json())
        const row = (s.settings ?? []).find((x: any) => x.key === settingKey)
        if (!cancelled && row?.value) setTierPrices(row.value as TierPrices)
      })
      .catch((e) => { if (!cancelled) setProfileError(e?.message ?? "Couldn't load the category") })
    return () => { cancelled = true }
  }, [selectedKey])

  const changeCategory = (next: string) => {
    if (next === selectedKey) return
    if (draft && !confirm("Switching category clears the current receiving. Save a draft first if you need it. Continue?")) return
    setDraft(null)
    setSelectedKey(next)
  }

  const label = (p: ProfileListItem) => p.primaryCannabinoid ? `${p.displayName} · ${p.primaryCannabinoid}` : p.displayName

  return (
    <Container className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-col">
          <Heading level="h1">Receiving</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Columns come from each category's settings in MBS Settings → Categories.
          </Text>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Label className="text-ui-fg-subtle">Category</Label>
          {(list ?? []).map((p) => (
            <Button key={p.key} size="small" variant={selectedKey === p.key ? "primary" : "secondary"} onClick={() => changeCategory(p.key)}>
              {label(p)}
            </Button>
          ))}
        </div>
      </div>

      {listError || profileError ? (
        <Text style={{ color: "#B91C1C" }}>Couldn't load {listError ? "categories" : "this category"}: {listError ?? profileError}. Reload the page.</Text>
      ) : !profile ? (
        <Text className="text-ui-fg-subtle">{list && list.length === 0 ? "No categories are set up yet." : "Loading…"}</Text>
      ) : draft ? (
        <ReviewView
          key={`${profile.key}:${draft.draftId ?? "new"}`}
          profile={profile}
          tierPrices={tierPrices}
          initial={draft}
          onRestart={() => setDraft(null)}
        />
      ) : (
        <StartView
          profile={profile}
          onStart={(d, draftId) => setDraft({ ...d, draftId })}
        />
      )}
    </Container>
  )
}

/* =========================================================
 * Start: resume a draft, upload an invoice, or type rows in
 * ========================================================= */
const StartView: React.FC<{
  profile: Profile
  onStart: (d: Draft, draftId: string | null) => void
}> = ({ profile, onStart }) => {
  const [drafts, setDrafts] = useState<Array<DraftRow & { old: boolean }>>([])
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const onlySub = profile.subcategories.length === 1 ? profile.subcategories[0].key : null

  const loadDrafts = useCallback(async () => {
    const get = (kind: string) => fetch(`/admin/receiving/drafts?kind=${encodeURIComponent(kind)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { drafts: [] })).then((j) => (j.drafts ?? []) as DraftRow[]).catch(() => [] as DraftRow[])
    const [mine, old] = await Promise.all([get(draftKind(profile.key)), get(profile.key)])
    setDrafts([...mine.map((d) => ({ ...d, old: false })), ...old.map((d) => ({ ...d, old: true }))])
  }, [profile.key])
  useEffect(() => { loadDrafts() }, [loadDrafts])

  const discard = async (id: string) => {
    if (!confirm("Discard this draft? Cannot be undone.")) return
    const res = await fetch(`/admin/receiving/drafts/${id}`, { method: "DELETE", credentials: "include" })
    if (res.ok) { toast.success("Draft discarded"); loadDrafts() } else toast.error("Failed to discard draft")
  }

  const pick = (f: File | null) => {
    setError(null)
    if (!f) { setFile(null); return }
    if (f.type !== "application/pdf") { setError(`Expected a PDF — got ${f.type || "unknown type"}`); return }
    if (f.size > 15 * 1024 * 1024) { setError(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB) — max 15 MB`); return }
    setFile(f)
  }

  const extract = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append("invoice", file)
      fd.append("profileKey", profile.key)
      const res = await fetch("/admin/receiving/extract", { method: "POST", credentials: "include", body: fd })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error ?? `Extract failed (${res.status})`)
      const invoice = json.data as Invoice
      toast.success("Invoice extracted", { description: `${invoice.lineItems.length} line items · ${json.tokensIn + json.tokensOut} tokens` })
      onStart({
        v: 2,
        invoice,
        fileName: json.fileName,
        tokens: { in: json.tokensIn, out: json.tokensOut },
        fromInvoice: true,
        rows: invoice.lineItems.map((li) => ({
          ...blankRow(onlySub),
          strainName: li.strainName,
          quantity: li.quantityLb,
          unitPrice: li.unitPricePerLb,
          strainType: profile.fields.strainType ? li.strainType ?? null : null,
          bestFor: profile.fields.strainType && li.strainType ? TYPE_TO_BEST_FOR[li.strainType] : null,
        })),
      }, null)
    } catch (e: any) {
      setError(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {drafts.length > 0 && (
        <div className="flex flex-col gap-3">
          <Heading level="h2">Resume Drafts</Heading>
          {drafts.map((d) => (
            <div key={d.id} className="flex flex-col gap-1">
              <DraftCard draft={d} onResume={() => onStart(fromOldDraft(d.payload), d.id)} onDiscard={() => discard(d.id)} />
              {d.old && (
                <Text size="xsmall" className="text-ui-fg-muted">
                  Saved on the old {profile.key === "pre-roll" ? "Pre-Rolls" : "Receiving"} page. Updating it here moves it to this page.
                </Text>
              )}
            </div>
          ))}
        </div>
      )}

      {profile.invoiceUpload ? (
        <>
          <Heading level="h2">{drafts.length > 0 ? "Or Upload a New Invoice" : "Upload Supplier Invoice"}</Heading>
          <Text className="text-ui-fg-subtle">
            Drop a supplier invoice PDF. The AI reads the supplier, the invoice details and one row per product, with
            quantities and costs in {profile.inputUnitLabel.plural}. You review and fill in the rest before saving.
          </Text>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files?.[0] ?? null) }}
            onClick={() => inputRef.current?.click()}
            style={{
              border: dragOver ? "2px solid #0A0A0A" : "2px dashed #C9C3B2",
              background: dragOver ? "rgba(10,10,10,0.04)" : "#FAFAF7",
              padding: "48px 24px", textAlign: "center", cursor: "pointer", transition: "all 120ms ease",
            }}
          >
            <input ref={inputRef} type="file" accept="application/pdf" style={{ display: "none" }}
              onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            <Text size="large" weight="plus">{file ? file.name : "Drop a PDF here"}</Text>
            <Text size="small" className="text-ui-fg-subtle">
              {file ? `${(file.size / 1024).toFixed(0)} KB · click or drop to replace` : "or click to browse · max 15 MB"}
            </Text>
          </div>
          {error && (
            <div style={{ border: "1.5px solid #B91C1C", padding: "12px 16px", background: "#fff" }}>
              <Text size="small" weight="plus" style={{ color: "#B91C1C" }}>{error}</Text>
            </div>
          )}
        </>
      ) : (
        <Text className="text-ui-fg-subtle">
          {profile.displayName} is typed in row by row. To read supplier invoices for it, turn on "Receive by invoice
          upload" in MBS Settings → Categories.
        </Text>
      )}

      <div className="flex justify-between items-center">
        <Button variant={profile.invoiceUpload ? "secondary" : "primary"} disabled={busy}
          onClick={() => onStart({ v: 2, invoice: blankInvoice(), fileName: "Manual Entry", tokens: { in: 0, out: 0 }, fromInvoice: false, rows: [blankRow(onlySub)] }, null)}>
          {profile.invoiceUpload ? "Skip — Enter Manually" : "Start Receiving"}
        </Button>
        {profile.invoiceUpload && (
          <Button variant="primary" disabled={!file || busy} onClick={extract}>{busy ? "Extracting…" : "Extract Invoice"}</Button>
        )}
      </div>
    </div>
  )
}

/* =========================================================
 * Review: header + spreadsheet
 * ========================================================= */

/* A spreadsheet column. Which ones show comes from the category. */
type Col = { id: string; header: React.ReactNode; width: number; align?: "left" | "right"; cell: (row: Row, i: number) => React.ReactNode }

const ReviewView: React.FC<{
  profile: Profile
  tierPrices: TierPrices | null
  initial: Draft & { draftId: string | null }
  onRestart: () => void
}> = ({ profile, tierPrices, initial, onRestart }) => {
  const f = profile.fields
  const unit = profile.inputUnitLabel
  const main = cannabinoidField(profile.primaryCannabinoid)
  const otherCols = useMemo(
    () => (f.cannabinoids ? otherCannabinoidColumns(profile.primaryCannabinoid, profile.otherCannabinoids) : []),
    [f.cannabinoids, profile.primaryCannabinoid, profile.otherCannabinoids],
  )
  const flat = profile.pricingModel === "flat"
  const showBatch = f.cannabinoids || f.coaRequired
  const subOptions = profile.subcategories.map((s) => ({ key: s.key, label: s.label }))
  const onlySub = subOptions.length === 1 ? subOptions[0].key : null

  const [invoice, setInvoice] = useState<Invoice>(initial.invoice)
  const [rows, setRows] = useState<Row[]>(initial.rows.length ? initial.rows : [blankRow(onlySub)])
  const [draftId, setDraftId] = useState<string | null>(initial.draftId)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(initial.draftId ? new Date() : null)
  const [saving, setSaving] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [coaParsing, setCoaParsing] = useState<Set<number>>(new Set())
  const [saveResults, setSaveResults] = useState<SaveRowResult[] | null>(null)
  const [preview, setPreview] = useState<{ key: string; results: PreviewResult[] } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saved, setSaved] = useState<{ historyId: string; created: number; restocked: number } | null>(null)
  const [pushedBillId, setPushedBillId] = useState<string | null>(null)
  const [pushingToQbo, setPushingToQbo] = useState(false)
  /* Rows with no cost save at $0 only when the operator says it's free
   * stock: a $0 cost blocks the QBO bill and Owner prices. */
  const [freeStockOk, setFreeStockOk] = useState(false)

  /* ---- Totals and shipping spread (by quantity share, as the old Flower page did) ---- */
  const totalQty = rows.reduce((s, r) => s + (r.quantity || 0), 0)
  const shipPerUnit = totalQty > 0 ? (invoice.shippingTotal || 0) / totalQty : 0
  const computedSubtotal = rows.reduce((s, r) => s + (r.quantity || 0) * (r.unitPrice || 0), 0)
  const computedTotal = computedSubtotal + (invoice.shippingTotal || 0)
  const zeroCostRows = rows.filter((r) => !((r.unitPrice || 0) > 0))
  const zeroCostBlocked = zeroCostRows.length > 0 && !freeStockOk
  const subtotalDiverges = initial.fromInvoice && invoice.subtotal != null && Math.abs(invoice.subtotal - computedSubtotal) > 0.01
  const totalDiverges = initial.fromInvoice && Math.abs((invoice.total || 0) - computedTotal) > 0.01

  /* ---- Duplicate / restock checks (same endpoint and flow the old Flower page used) ---- */
  useEffect(() => {
    const names = rows.map((r) => r.strainName).filter(Boolean)
    if (names.length === 0) return
    let cancelled = false
    fetch("/admin/receiving/check-duplicates", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ strainNames: names, profileKey: profile.key }),
    })
      .then((r) => r.json())
      .then((j) => {
        const matches: Record<string, NearMatch[]> = j.matches ?? {}
        if (cancelled || Object.keys(matches).length === 0) return
        setRows((cur) => cur.map((r) => ({ ...r, nearMatches: matches[r.strainName] ?? [] })))
      })
      .catch(() => { /* a hint, not load-bearing */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const classificationKey = useMemo(
    () => JSON.stringify(rows.map((r) => ({ s: r.strainName ?? "", t: r.subcategory ?? null }))),
    [rows],
  )
  useEffect(() => {
    const parsed = JSON.parse(classificationKey) as Array<{ s: string; t: string | null }>
    if (parsed.every((p) => !p.s)) return
    let cancelled = false
    const t = setTimeout(() => {
      fetch("/admin/receiving/check-duplicates", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ profileKey: profile.key, rows: parsed.map((p) => ({ strainName: p.s, tier: p.t })) }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return
          const out = (j.matches ?? []) as Classification[]
          setRows((cur) => cur.map((row, i) => {
            const c = out[i]
            if (!c) return row
            return {
              ...row,
              classification: { restock: c.restock, tierConflict: c.tierConflict, near: c.near },
              confirmedTierConflict: c.tierConflict ? row.confirmedTierConflict : false,
            }
          }))
        })
        .catch(() => { /* silent */ })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [classificationKey, profile.key])

  const unconfirmedConflicts = rows.filter((r) => r.classification?.tierConflict && !r.confirmedTierConflict).length

  /* ---- Completeness: what this category asks for ---- */
  const vendors = useQboVendors()
  const headerComplete = !!(supplierReady(invoice.supplier, vendors) && invoice.invoiceNumber.trim() && invoice.invoiceDate)
  const isRowComplete = useCallback((r: Row): boolean => !!(
    r.strainName.trim() &&
    r.quantity > 0 &&
    r.subcategory &&
    (!flat || r.sellPrice > 0) &&
    (!f.strainType || r.strainType) &&
    (!f.bestFor || r.bestFor) &&
    (!f.cannabinoids || (
      r.mainPercent.trim() &&
      r.totalCannabinoidsPercent.trim() &&
      otherCols.every((o) => !o.required || (r.otherPercents[o.cannabinoid] ?? "").trim())
    )) &&
    (f.coaRequired ? r.coa.state === "ready" : r.coa.state !== "uploading")
  ), [flat, f.strainType, f.bestFor, f.cannabinoids, f.coaRequired, otherCols])
  const allValid = headerComplete && rows.length > 0 && rows.every(isRowComplete)

  /* ---- Row edits ---- */
  const withBestFor = (r: Row, patch: Partial<Row>): Row => {
    const next = { ...r, ...patch }
    if (f.bestFor && patch.strainType !== undefined && patch.strainType !== r.strainType) {
      next.bestFor = patch.strainType ? TYPE_TO_BEST_FOR[patch.strainType] : null
    }
    return next
  }
  const updateRow = useCallback((idx: number, patch: Partial<Row>) => {
    setRows((cur) => cur.map((r, i) => (i === idx ? withBestFor(r, patch) : r)))
    setSaveResults(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.bestFor])
  const bulkApply = (patch: Partial<Row>) => {
    if (selected.size === 0) return
    setRows((cur) => cur.map((r, i) => (selected.has(i) ? withBestFor(r, patch) : r)))
    setSelected(new Set())
  }
  const useExistingMatch = (idx: number, m: NearMatch) => {
    setRows((cur) => cur.map((r, i) => i === idx
      ? { ...r, strainName: m.title, subcategory: m.tier, nearMatches: [], classification: null, confirmedTierConflict: false }
      : r))
    setSaveResults(null)
  }
  const addRow = () => { setRows((cur) => [...cur, blankRow(onlySub)]); setSaveResults(null) }
  const deleteSelected = () => {
    if (selected.size === 0 || !confirm(`Delete ${selected.size} row(s)?`)) return
    setRows((cur) => cur.filter((_, i) => !selected.has(i)))
    setSelected(new Set())
    setSaveResults(null)
  }
  const toggleRow = (idx: number) => setSelected((cur) => {
    const next = new Set(cur)
    next.has(idx) ? next.delete(idx) : next.add(idx)
    return next
  })
  const toggleAll = () => setSelected((cur) => (cur.size === rows.length ? new Set() : new Set(rows.map((_, i) => i))))
  const toggleEffect = (idx: number, e: string) => setRows((cur) => cur.map((r, i) => {
    if (i !== idx) return r
    if (r.effects.includes(e)) return { ...r, effects: r.effects.filter((x) => x !== e) }
    return r.effects.length >= MAX_EFFECTS ? r : { ...r, effects: [...r.effects, e] }
  }))

  /* ---- COA reader: main %, the other cannabinoids, Cann %, batch ---- */
  const parseCoaForRow = useCallback(async (idx: number): Promise<"ok" | "skipped" | "error"> => {
    const row = rows[idx]
    if (!row || row.coa.state !== "ready") return "skipped"
    setCoaParsing((cur) => new Set(cur).add(idx))
    try {
      const res = await fetch("/admin/receiving/coa-parse", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          coaUrl: row.coa.url,
          primary: profile.primaryCannabinoid ?? undefined,
          others: otherCols.map((o) => o.cannabinoid),
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error ?? `Parse failed (${res.status})`)
      setRows((cur) => cur.map((r, i) => i === idx ? {
        ...r,
        mainPercent: json.thcaPercent != null ? String(json.thcaPercent) : r.mainPercent,
        otherPercents: {
          ...r.otherPercents,
          ...(json.d9Percent != null ? { D9: String(json.d9Percent) } : {}),
          ...Object.fromEntries(Object.entries(json.others ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
        },
        totalCannabinoidsPercent: json.totalCannabinoidsPercent != null ? String(json.totalCannabinoidsPercent) : r.totalCannabinoidsPercent,
        batchId: json.batchId ? String(json.batchId) : r.batchId,
        coaNotes: json.notes ?? null,
      } : r))
      return "ok"
    } catch (e: any) {
      toast.error(`COA parse failed for ${row.strainName}`, { description: e?.message ?? "Network error" })
      return "error"
    } finally {
      setCoaParsing((cur) => { const next = new Set(cur); next.delete(idx); return next })
    }
  }, [rows, profile.primaryCannabinoid, otherCols])

  const parseAllCoas = async () => {
    const targets = rows.map((r, i) => ({ r, i }))
      .filter(({ r }) => r.coa.state === "ready" && (
        !r.mainPercent.trim() || !r.totalCannabinoidsPercent.trim() ||
        otherCols.some((o) => !(r.otherPercents[o.cannabinoid] ?? "").trim())))
      .map(({ i }) => i)
    if (targets.length === 0) {
      toast.info("Nothing to extract", { description: "Every row with a COA already has its percentages filled." })
      return
    }
    let parsed = 0, failed = 0, cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const result = await parseCoaForRow(targets[cursor++])
        if (result === "ok") parsed++
        else if (result === "error") failed++
      }
    }
    const t0 = Date.now()
    await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker))
    toast.success("Auto-fill complete", { description: `${parsed} parsed · ${failed} failed · ${((Date.now() - t0) / 1000).toFixed(1)}s` })
  }

  /* ---- Draft ---- */
  const onSaveDraft = async () => {
    setSavingDraft(true)
    try {
      const payload: Draft = { v: 2, invoice, fileName: initial.fileName, tokens: initial.tokens, fromInvoice: initial.fromInvoice, rows }
      const summary = {
        kind: draftKind(profile.key),
        fileName: initial.fileName,
        supplierName: invoice.supplier.name,
        invoiceNumber: invoice.invoiceNumber,
        lineItemCount: rows.length,
        completeRows: rows.filter(isRowComplete).length,
      }
      const res = await fetch(draftId ? `/admin/receiving/drafts/${draftId}` : "/admin/receiving/drafts", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ payload, summary }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.message ?? `Save failed (${res.status})`)
      if (!draftId) setDraftId(json.draft.id)
      setLastSavedAt(new Date())
      toast.success(draftId ? "Draft updated" : "Draft saved", { description: "You can close this tab and resume later." })
    } catch (e: any) {
      toast.error("Couldn't save draft", { description: e?.message ?? "Network error" })
    } finally {
      setSavingDraft(false)
    }
  }

  /* ---- Save: the same /admin/receiving/save as the other pages ---- */
  const buildPayload = () => ({
    profileKey: profile.key,
    supplier: invoice.supplier,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    shippingTotal: invoice.shippingTotal,
    /* The supplier's printed total when read from an invoice; typed-in
     * receivings use the rows' total, as the Pre-Rolls page did. */
    total: initial.fromInvoice ? invoice.total : computedTotal,
    computedSubtotal,
    computedTotal,
    draftId: draftId ?? undefined,
    ...(zeroCostRows.length > 0 && freeStockOk ? { freeStock: true } : {}),
    rows: rows.map((r) => ({
      strainName: r.strainName.trim(),
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      ...(flat ? { sellPrice: r.sellPrice } : {}),
      tier: r.subcategory,
      strainType: f.strainType ? r.strainType : null,
      bestFor: f.bestFor ? r.bestFor : null,
      effects: f.effects ? r.effects : [],
      coaUrl: r.coa.state === "ready" ? r.coa.url : null,
      coaOriginalName: r.coa.state === "ready" ? r.coa.originalName : null,
      ...(f.cannabinoids ? {
        [main.rowField]: r.mainPercent.trim() || null,
        ...Object.fromEntries(otherCols.map((o) => [o.rowField, (r.otherPercents[o.cannabinoid] ?? "").trim() || null])),
        totalCannabinoidsPercent: r.totalCannabinoidsPercent.trim() || null,
      } : {}),
      ...(showBatch ? { batchId: r.batchId.trim() || null } : {}),
      ...(f.upc ? { upc: r.upc.trim() || null } : {}),
    })),
  })
  /* What the last preview was of: any change after it makes it stale. */
  const payloadKey = JSON.stringify(buildPayload())

  /* Same request with preview: true. The route runs every check and
   * says what each row would do; nothing is written. */
  const onPreview = async () => {
    if (!allValid || previewing) return
    setPreviewing(true)
    try {
      const res = await fetch("/admin/receiving/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...buildPayload(), preview: true }),
      })
      const json = await res.json()
      if (!json?.summary) throw new Error(json?.error ?? `Preview failed (${res.status})`)
      setPreview({ key: payloadKey, results: json.results ?? [] })
    } catch (e: any) {
      toast.error("Preview failed", { description: e?.message ?? "Network error" })
    } finally {
      setPreviewing(false)
    }
  }

  const onSave = async () => {
    if (!allValid || saving || zeroCostBlocked) return
    setSaving(true)
    setSaveResults(null)
    try {
      const payload = buildPayload()
      const idempotencyKey = (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function")
        ? (crypto as any).randomUUID()
        : `rcv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const res = await fetch("/admin/receiving/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        credentials: "include",
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok && !json?.summary) throw new Error(json?.error ?? `Save failed (${res.status})`)
      setSaveResults(json.results ?? [])
      const s = json.summary as { created: number; restocked: number; failed: number; alreadySaved?: number }
      const skipped = s.alreadySaved ? ` · ${s.alreadySaved} already saved, skipped` : ""
      if (json.nothingSaved) {
        toast.warning(`Nothing saved: ${s.failed} row${s.failed === 1 ? "" : "s"} need fixing`, {
          description: "No stock or products were changed. Fix the rows marked failed and save again.",
        })
      } else if (s.failed === 0) {
        toast.success("Receiving saved", { description: `${s.created} created · ${s.restocked} restocked${skipped}` })
        setDraftId(null)
        if (json.historyId) setSaved({ historyId: json.historyId, created: s.created, restocked: s.restocked })
      } else {
        toast.warning(`${s.failed} of ${s.failed + s.created + s.restocked + (s.alreadySaved ?? 0)} rows failed`, {
          description: "The other rows are saved. Fix the failed rows and save again: rows already saved are skipped.",
        })
      }
    } catch (e: any) {
      toast.error("Save failed", { description: e?.message ?? "Network error" })
    } finally {
      setSaving(false)
    }
  }

  const onPushToQbo = async () => {
    if (!saved) return
    setPushingToQbo(true)
    try {
      const res = await fetch("/admin/qbo/push-bill", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId: saved.historyId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `Push failed (${res.status})`)
      setPushedBillId(json.billId)
      toast.success("Pushed to QuickBooks", { description: `Bill ${json.billId} · ${json.lines} line(s)` })
    } catch (e: any) {
      toast.error("Push failed", { description: e?.message ?? "Network error" })
    } finally {
      setPushingToQbo(false)
    }
  }

  /* ---- The category's columns ---- */
  const variantsFor = (sub: string | null) =>
    profile.subcategories.find((s) => s.key === sub)?.variants ?? profile.variants
  const select = (value: string | null, options: Array<{ key: string; label: string }>, onPick: (v: string) => void) => (
    <Select value={value ?? ""} onValueChange={onPick}>
      <Select.Trigger><Select.Value placeholder="—" /></Select.Trigger>
      <Select.Content>
        {options.map((o) => <Select.Item key={o.key} value={o.key}>{o.label}</Select.Item>)}
      </Select.Content>
    </Select>
  )
  const pctInput = (value: string, onChange: (v: string) => void, opts: { allowsNd?: boolean; placeholder?: string } = {}) => (
    <Input type={opts.allowsNd ? "text" : "number"} step="0.01" placeholder={opts.allowsNd ? "0.05 or ND" : opts.placeholder ?? "—"}
      value={value} onChange={(e) => onChange(e.target.value)} style={{ textAlign: "right" }} />
  )

  const cols: Col[] = [
    {
      id: "select", width: 30,
      header: <CheckBox checked={selected.size === rows.length && rows.length > 0} indeterminate={selected.size > 0 && selected.size < rows.length} onChange={toggleAll} />,
      cell: (_r, i) => <CheckBox checked={selected.has(i)} onChange={() => toggleRow(i)} />,
    },
    {
      id: "name", width: 200, header: f.strainType ? "Strain" : "Product",
      cell: (row, i) => (
        <>
          <Input value={row.strainName} onChange={(e) => updateRow(i, { strainName: e.target.value })} />
          <RowNotices row={row}
            onConfirmConflict={(v) => updateRow(i, { confirmedTierConflict: v })}
            onSwitchToExisting={(sub) => updateRow(i, { subcategory: sub, confirmedTierConflict: false })}
            onUseMatch={(m) => useExistingMatch(i, m)} />
          {saveResults?.[i] && <SaveStatusPill result={saveResults[i]} />}
        </>
      ),
    },
    {
      id: "qty", width: 80, header: `Qty (${unit.singular})`,
      cell: (row, i) => <Input type="number" step="0.01" value={row.quantity} onChange={(e) => updateRow(i, { quantity: Number(e.target.value) || 0 })} />,
    },
    {
      id: "cost", width: 100, header: `Cost / ${unit.singular}`,
      cell: (row, i) => <Input type="number" step="0.01" value={row.unitPrice} onChange={(e) => updateRow(i, { unitPrice: Number(e.target.value) || 0 })} />,
    },
    ...(flat ? [{
      id: "sell", width: 100, header: "Sell price",
      cell: (row: Row, i: number) => <Input type="number" step="0.01" value={row.sellPrice || ""} onChange={(e) => updateRow(i, { sellPrice: Number(e.target.value) || 0 })} />,
    }] : []),
    {
      id: "sub", width: 120, header: "Sub-category",
      cell: (row, i) => select(row.subcategory, subOptions, (v) => updateRow(i, { subcategory: v })),
    },
    ...(f.strainType ? [{
      id: "type", width: 110, header: "Type",
      cell: (row: Row, i: number) => select(row.strainType, STRAIN_TYPE_OPTIONS.map((o) => ({ key: o, label: o })), (v) => updateRow(i, { strainType: v as StrainType })),
    }] : []),
    ...(f.bestFor ? [{
      id: "bestFor", width: 100, header: "Best For",
      cell: (row: Row, i: number) => select(row.bestFor, [...BEST_FOR_OPTIONS], (v) => updateRow(i, { bestFor: v as BestFor })),
    }] : []),
    ...(f.cannabinoids ? [
      {
        id: "main", width: 130, align: "right" as const, header: main.label,
        cell: (row: Row, i: number) => (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
              {pctInput(row.mainPercent, (v) => updateRow(i, { mainPercent: v }), { allowsNd: main.allowsNd })}
              <CoaAiButton canParse={row.coa.state === "ready"} parsing={coaParsing.has(i)} onClick={() => parseCoaForRow(i)} />
            </div>
            {row.coaNotes && (
              <span title={row.coaNotes} style={{ display: "inline-block", marginTop: 2, color: "#C98A00", fontSize: 11, cursor: "help" }}>⚠ AI note</span>
            )}
          </>
        ),
      },
      ...otherCols.map((o) => ({
        id: `other:${o.cannabinoid}`, width: 100, align: "right" as const, header: o.label,
        cell: (row: Row, i: number) => pctInput(row.otherPercents[o.cannabinoid] ?? "",
          (v) => updateRow(i, { otherPercents: { ...row.otherPercents, [o.cannabinoid]: v } }),
          { allowsNd: o.allowsNd, placeholder: o.required ? "—" : "optional" }),
      })),
      {
        id: "cann", width: 100, align: "right" as const, header: "Cann %",
        cell: (row: Row, i: number) => pctInput(row.totalCannabinoidsPercent, (v) => updateRow(i, { totalCannabinoidsPercent: v })),
      },
    ] : []),
    ...(showBatch ? [{
      id: "batch", width: 130, header: "Batch ID",
      cell: (row: Row, i: number) => <Input type="text" placeholder="—" value={row.batchId} onChange={(e) => updateRow(i, { batchId: e.target.value })} />,
    }] : []),
    ...(f.effects ? [{
      id: "effects", width: 220, header: "Effects",
      cell: (row: Row, i: number) => (
        <>
          <div className="flex flex-wrap gap-1">
            {EFFECT_OPTIONS.map((e) => {
              const on = row.effects.includes(e)
              const disabled = !on && row.effects.length >= MAX_EFFECTS
              return (
                <button key={e} type="button" disabled={disabled} onClick={() => toggleEffect(i, e)}
                  title={disabled ? "Max 2 effects per product" : undefined}
                  style={{
                    border: "1px solid #0A0A0A", background: on ? "#0A0A0A" : "transparent", color: on ? "#FAFAF7" : "#0A0A0A",
                    opacity: disabled ? 0.3 : 1, fontSize: 11, padding: "2px 6px", fontFamily: "monospace",
                    textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer",
                  }}>
                  {e}
                </button>
              )
            })}
          </div>
          <Text size="xsmall" className="text-ui-fg-muted" style={{ marginTop: 4 }}>{row.effects.length}/{MAX_EFFECTS} selected</Text>
        </>
      ),
    }] : []),
    ...(f.upc ? [{
      id: "upc", width: 140, header: "UPC",
      cell: (row: Row, i: number) => <Input type="text" placeholder="optional" value={row.upc} onChange={(e) => updateRow(i, { upc: e.target.value })} />,
    }] : []),
    {
      id: "coa", width: 140, header: f.coaRequired ? "COA" : "COA (optional)",
      cell: (row, i) => <CoaUpload coa={row.coa} onChange={(c) => updateRow(i, { coa: c })} />,
    },
    {
      id: "landed", width: 100, align: "right", header: `Landed / ${unit.singular}`,
      cell: (row) => <span style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>{fmtMoney((row.unitPrice || 0) + shipPerUnit)}</span>,
    },
    ...(!flat ? [{
      id: "prices", width: 260, align: "right" as const, header: "Default prices",
      cell: (row: Row) => {
        if (!row.subcategory) return <span className="text-ui-fg-muted">— pick sub-category —</span>
        const tp = tierPrices?.[row.subcategory]
        if (!tierPrices) return <span style={{ color: "#C98A00" }}>— price table not set up —</span>
        if (!tp) return <span style={{ color: "#C98A00" }}>— no prices for {row.subcategory} —</span>
        return (
          <span style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
            {variantsFor(row.subcategory).filter((v) => tp[v.sizeKey] != null).map((v) => `${v.label} ${fmtMoneyWhole(tp[v.sizeKey])}`).join(" · ")}
          </span>
        )
      },
    }] : []),
  ]

  /* Widths per category, since each has its own columns. */
  const { widths, startResize, totalWidth, reset } = useColumnWidths(
    `mbs:receiving:category:${profile.key}:${cols.map((c) => c.id).join(",")}`,
    cols.map((c) => c.width),
  )

  if (saved) {
    return (
      <div style={{ border: "1.5px solid var(--tier-exotic, #549402)", background: "#fff", padding: 24 }}>
        <Heading level="h2" style={{ color: "var(--tier-exotic, #549402)" }}>✓ Receiving Saved</Heading>
        <Text size="base" className="text-ui-fg-subtle" style={{ marginTop: 4 }}>
          {invoice.invoiceNumber} · {saved.created} created · {saved.restocked} restocked
        </Text>
        <div className="flex gap-2 mt-4 flex-wrap items-center">
          {pushedBillId ? (
            <Badge color="purple">✓ Pushed to QBO · Bill {pushedBillId}</Badge>
          ) : (
            <Button variant="primary" isLoading={pushingToQbo} onClick={onPushToQbo}>Push to QuickBooks</Button>
          )}
          <Button asChild variant="secondary"><a href={`/app/receiving/history/${saved.historyId}`}>View in History</a></Button>
          <Button asChild variant="secondary"><a href="/app/products">Open Products</a></Button>
          <Button variant="transparent" onClick={onRestart}>Start New Receiving</Button>
        </div>
      </div>
    )
  }

  const saveLabel = saving ? "Saving…" : zeroCostBlocked ? "Add Cost or Confirm Free Stock" : unconfirmedConflicts > 0
    ? `Resolve ${unconfirmedConflicts} Conflict${unconfirmedConflicts === 1 ? "" : "s"} First`
    : `Save ${rows.length} Product${rows.length === 1 ? "" : "s"}`
  const incomplete = rows.filter((r) => !isRowComplete(r)).length

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center gap-4 flex-wrap">
        <div className="flex flex-col">
          <Heading level="h2">Review · {profile.displayName}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {initial.fileName}{initial.fromInvoice && <> · {initial.tokens.in + initial.tokens.out} tokens</>}
            {lastSavedAt && <> · draft saved {formatRelativeTime(lastSavedAt)}</>}
          </Text>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onRestart}>Start Over</Button>
          <Button variant="secondary" disabled={savingDraft} onClick={onSaveDraft}>
            {savingDraft ? "Saving…" : draftId ? "Update Draft" : "Save Draft"}
          </Button>
          <Button variant="secondary" disabled={!allValid || previewing} onClick={onPreview}>
            {previewing ? "Previewing…" : "Preview Save"}
          </Button>
          <Button variant="primary" disabled={!allValid || saving || unconfirmedConflicts > 0 || zeroCostBlocked} onClick={onSave}>{saveLabel}</Button>
        </div>
      </div>

      {preview && (
        <PreviewPanel results={preview.results} stale={preview.key !== payloadKey}
          unitLabel={unit.singular} onClose={() => setPreview(null)} />
      )}

      {zeroCostRows.length > 0 && (
        <div className="flex flex-col gap-2" style={{ border: "1.5px solid #C98A00", padding: "10px 14px", background: "#fff" }}>
          <Text size="small" weight="plus" style={{ color: "#C98A00", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            No cost on {zeroCostRows.length} row{zeroCostRows.length === 1 ? "" : "s"}
          </Text>
          <Text size="small">
            {zeroCostRows.map((r) => r.strainName.trim() || "(unnamed)").join(", ")}. Enter the cost per {unit.singular}, or confirm
            this is free stock. Free stock saves at $0: it isn't on the QuickBooks bill and gets no Owner prices.
            A restock keeps the product's current cost.
          </Text>
          <div className="flex items-center gap-2">
            <Checkbox id="free-stock" checked={freeStockOk} onCheckedChange={(v) => setFreeStockOk(v === true)} />
            <Label htmlFor="free-stock" size="small">This is free stock: save at $0 cost</Label>
          </div>
        </div>
      )}

      {invoice.notes && (
        <div style={{ border: "1.5px solid #C98A00", padding: "10px 14px", background: "#fff" }}>
          <Text size="small" weight="plus" style={{ color: "#C98A00", textTransform: "uppercase", letterSpacing: "0.1em" }}>AI Notes</Text>
          <Text size="small">{invoice.notes}</Text>
        </div>
      )}

      {/* Supplier + invoice */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-3" style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>Supplier</Text>
          <Field label="Name (required)">
            <VendorPicker supplier={invoice.supplier} list={vendors}
              onChange={(supplier) => setInvoice((c) => ({ ...c, supplier }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone">
              <Input value={invoice.supplier.phone ?? ""} onChange={(e) => setInvoice((c) => ({ ...c, supplier: { ...c.supplier, phone: e.target.value || null } }))} />
            </Field>
            <Field label="Email">
              <Input value={invoice.supplier.email ?? ""} onChange={(e) => setInvoice((c) => ({ ...c, supplier: { ...c.supplier, email: e.target.value || null } }))} />
            </Field>
          </div>
          <Field label="Address">
            <Textarea rows={2} value={invoice.supplier.address ?? ""} onChange={(e) => setInvoice((c) => ({ ...c, supplier: { ...c.supplier, address: e.target.value || null } }))} />
          </Field>
        </div>

        <div className="flex flex-col gap-3" style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>Invoice</Text>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Invoice # (required)">
              <Input value={invoice.invoiceNumber} onChange={(e) => setInvoice((c) => ({ ...c, invoiceNumber: e.target.value }))} />
            </Field>
            <Field label="Date (required)">
              <Input type="date" value={invoice.invoiceDate} onChange={(e) => setInvoice((c) => ({ ...c, invoiceDate: e.target.value }))} />
            </Field>
          </div>
          <Field label="Shipping">
            <Input type="number" step="0.01" value={invoice.shippingTotal}
              onChange={(e) => setInvoice((c) => ({ ...c, shippingTotal: Number(e.target.value) || 0 }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2" style={{ borderTop: "1px solid #E5E1D6", paddingTop: 10 }}>
            {initial.fromInvoice && (
              <Field label="From invoice (AI-extracted)">
                <div className="flex flex-col gap-1" style={{ fontFamily: "monospace", fontSize: 13 }}>
                  <div className="flex justify-between"><span className="text-ui-fg-subtle">Subtotal</span><span>{fmtMoneyWhole(invoice.subtotal ?? 0)}</span></div>
                  <div className="flex justify-between items-center">
                    <span className="text-ui-fg-subtle">Total</span>
                    <Input type="number" step="0.01" value={invoice.total} style={{ width: 120, textAlign: "right" }}
                      onChange={(e) => setInvoice((c) => ({ ...c, total: Number(e.target.value) || 0 }))} />
                  </div>
                </div>
              </Field>
            )}
            <Field label="Computed from rows">
              <div className="flex flex-col gap-1" style={{ fontFamily: "monospace", fontSize: 13 }}>
                <div className="flex justify-between">
                  <span className="text-ui-fg-subtle">Σ qty × cost</span>
                  <span style={{ color: subtotalDiverges ? "#C98A00" : "#0A0A0A", fontWeight: subtotalDiverges ? 600 : 400 }}>{fmtMoney(computedSubtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ui-fg-subtle">+ shipping</span>
                  <span style={{ color: totalDiverges ? "#C98A00" : "#549402", fontWeight: 600 }}>{fmtMoney(computedTotal)}</span>
                </div>
              </div>
            </Field>
          </div>
          {(subtotalDiverges || totalDiverges) && (
            <div style={{ background: "rgba(201,138,0,0.1)", border: "1px solid #C98A00", padding: "6px 10px" }}>
              <Text size="xsmall" style={{ color: "#C98A00", fontFamily: "monospace" }}>
                ⚠ Computed differs from invoice by ${Math.abs(computedTotal - (invoice.total || 0)).toFixed(2)}.
                Inventory is saved at the computed amount; the QuickBooks bill uses the invoice total.
              </Text>
            </div>
          )}
          <div className="flex justify-between items-center" style={{ borderTop: "1px solid #E5E1D6", paddingTop: 8 }}>
            <Text size="small" className="text-ui-fg-subtle">Shipping spread</Text>
            <Text size="small" weight="plus" style={{ fontFamily: "monospace" }}>{fmtMoney(shipPerUnit)} / {unit.singular}</Text>
          </div>
        </div>
      </div>

      {f.cannabinoids && (
        <div className="flex justify-end items-center gap-2" style={{ marginTop: -4 }}>
          <Text size="xsmall" className="text-ui-fg-muted" style={{ fontFamily: "monospace" }}>
            {coaParsing.size > 0 ? `parsing ${coaParsing.size}…` : "~$0.011 / row"}
          </Text>
          <Button variant="secondary" size="small" disabled={coaParsing.size > 0} onClick={parseAllCoas}>
            AI: Auto-fill {[main.label, ...otherCols.map((o) => o.label), "Cann %"].join(" / ")} from COAs
          </Button>
        </div>
      )}

      <BulkCoaDropzone
        rows={rows}
        onApply={(staged) => setRows((cur) => cur.map((r, i) => {
          const s = staged.get(i)
          return s ? { ...r, coa: { state: "uploading", originalName: s.file.name } } : r
        }))}
        onResultPerFile={(idx, result) => setRows((cur) => cur.map((r, i) => {
          if (i !== idx) return r
          return "error" in result
            ? { ...r, coa: { state: "error", originalName: result.originalName, error: result.error } }
            : { ...r, coa: { state: "ready", url: result.url, originalName: result.originalName, mimeType: result.mimeType } }
        }))}
      />

      {selected.size > 0 && (
        <div style={{ background: "#0A0A0A", color: "#FAFAF7", padding: "10px 14px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", position: "sticky", top: 0, zIndex: 20 }}>
          <Text size="small" weight="plus" style={{ color: "#FAFAF7", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            {selected.size} selected
          </Text>
          <span style={{ color: "#888", fontSize: 12 }}>Apply to selected:</span>
          <BulkSelect placeholder="Sub-category" options={subOptions.map((o) => ({ value: o.key, label: o.label }))} onPick={(v) => bulkApply({ subcategory: v })} />
          {f.strainType && <BulkSelect placeholder="Type" options={STRAIN_TYPE_OPTIONS.map((o) => ({ value: o, label: o }))} onPick={(v) => bulkApply({ strainType: v as StrainType })} />}
          {f.bestFor && <BulkSelect placeholder="Best For" options={BEST_FOR_OPTIONS.map((o) => ({ value: o.key, label: o.label }))} onPick={(v) => bulkApply({ bestFor: v as BestFor })} />}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={deleteSelected}
            style={{ background: "transparent", border: "1px solid #B91C1C", color: "#B91C1C", padding: "4px 12px", fontSize: 11, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.05em", cursor: "pointer" }}>
            Delete {selected.size}
          </button>
          <button type="button" onClick={() => setSelected(new Set())}
            style={{ background: "transparent", border: "1px solid #FAFAF7", color: "#FAFAF7", padding: "4px 12px", fontSize: 11, fontFamily: "monospace", textTransform: "uppercase", cursor: "pointer" }}>
            Clear
          </button>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -18 }}>
        <button type="button" onClick={reset} title="Reset all column widths to defaults"
          style={{ background: "transparent", border: "1px solid #E5E1D6", padding: "4px 10px", fontSize: 11, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer" }}>
          Reset Columns
        </button>
      </div>
      <div style={{ border: "1.5px solid #E5E1D6", overflowX: "auto" }}>
        <table style={{ tableLayout: "fixed", width: totalWidth, borderCollapse: "collapse", fontSize: 13 }}>
          <colgroup>{widths.map((w, ci) => <col key={ci} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr style={{ background: "#F3F1EA", borderBottom: "1.5px solid #0A0A0A" }}>
              {cols.map((c, ci) => <Th key={c.id} align={c.align} onResize={startResize(ci)}>{c.header}</Th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{
                borderBottom: "1px solid #E5E1D6",
                background: selected.has(i) ? "rgba(217,55,55,0.06)" : isRowComplete(row) ? "rgba(84,148,2,0.06)" : "rgba(201,138,0,0.06)",
              }}>
                {cols.map((c) => <Td key={c.id} align={c.align}>{c.cell(row, i)}</Td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-start">
        <button type="button" onClick={addRow}
          style={{ background: "transparent", border: "1px dashed #C9C3B2", padding: "8px 16px", fontSize: 12, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer", color: "#0A0A0A" }}>
          + Add Row
        </button>
      </div>

      <div className="flex justify-between items-center" style={{ borderTop: "1px solid #E5E1D6", paddingTop: 12 }}>
        <div className="flex gap-4 items-center">
          <Badge color={allValid ? "green" : "orange"}>
            {allValid ? "Ready to save" : !headerComplete ? "Supplier (a QuickBooks vendor), invoice # and date needed" : `${incomplete} row${incomplete === 1 ? "" : "s"} incomplete`}
          </Badge>
          <Text size="small" className="text-ui-fg-subtle">
            {rows.length} products · {totalQty.toFixed(2)} {totalQty === 1 ? unit.singular : unit.plural} total
          </Text>
        </div>
        <Button variant="primary" disabled={!allValid || saving || unconfirmedConflicts > 0 || zeroCostBlocked} onClick={onSave}>{saveLabel}</Button>
      </div>
    </div>
  )
}

/* Restock / sub-category conflict / possible-duplicate notices under a
 * row's name, as the old Flower page did. */
const RowNotices: React.FC<{
  row: Row
  onConfirmConflict: (v: boolean) => void
  onSwitchToExisting: (sub: string) => void
  onUseMatch: (m: NearMatch) => void
}> = ({ row, onConfirmConflict, onSwitchToExisting, onUseMatch }) => {
  const c = row.classification
  return (
    <>
      {c?.restock && (
        <div style={{ marginTop: 4, padding: "4px 6px", background: "rgba(84,148,2,0.08)", border: "1px solid #549402", fontSize: 11, fontFamily: "monospace", color: "#3d6c01" }}>
          ↻ Restock — <strong>{c.restock.title}</strong> ({c.restock.tier}) inventory will be incremented.
        </div>
      )}
      {c?.tierConflict && (
        <div style={{ marginTop: 4, padding: "6px 8px", background: "rgba(217,55,55,0.08)", border: "1.5px solid #D93737", fontSize: 11, fontFamily: "monospace", color: "#7F1D1D" }}>
          <div style={{ marginBottom: 4 }}>
            ⚠ <strong>{c.tierConflict.title}</strong> already exists in <strong>{c.tierConflict.tier}</strong>.
            Receiving as <strong>{row.subcategory}</strong> creates a separate product.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "#0A0A0A" }}>
            <input type="checkbox" checked={row.confirmedTierConflict} onChange={(e) => onConfirmConflict(e.target.checked)} />
            <span>Confirm — create as separate {row.subcategory} product</span>
          </label>
          {!row.confirmedTierConflict && (
            <button type="button" onClick={() => onSwitchToExisting(c.tierConflict!.tier)}
              style={{ marginTop: 4, background: "#0A0A0A", color: "#fff", border: "none", padding: "2px 8px", fontSize: 10, fontFamily: "monospace", textTransform: "uppercase", cursor: "pointer" }}>
              Or switch to {c.tierConflict.tier} (restock)
            </button>
          )}
        </div>
      )}
      {row.nearMatches.length > 0 && (
        <div style={{ marginTop: 4, padding: "4px 6px", background: "rgba(201,138,0,0.08)", border: "1px solid #C98A00", fontSize: 11, fontFamily: "monospace" }}>
          <div style={{ color: "#C98A00", marginBottom: 2 }}>⚠ Possible duplicate of:</div>
          {row.nearMatches.map((m, j) => (
            <div key={j} style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center", padding: "1px 0" }}>
              <span title={`Levenshtein distance: ${m.distance}`}>{m.title} <span style={{ color: "#888" }}>({m.tier})</span></span>
              <button type="button" onClick={() => onUseMatch(m)}
                style={{ background: "#C98A00", color: "#fff", border: "none", padding: "1px 6px", fontSize: 10, fontFamily: "monospace", textTransform: "uppercase", cursor: "pointer" }}>
                Use
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export const config = defineRouteConfig({
  label: "Receiving",
  icon: TruckIcon,
})

export default CategoryReceivingPage

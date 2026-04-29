import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
  Textarea,
  Badge,
  toast,
} from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/**
 * Receiving — operator uploads a supplier invoice PDF, AI extracts the
 * line items, operator picks attribute dropdowns per row + uploads a
 * COA per row, then Save triggers product upserts in Medusa.
 *
 * Flow:
 *   1. Upload view: dropzone → POST /admin/receiving/extract → spinner
 *   2. Review view: editable supplier/invoice header + spreadsheet
 *      table with one row per strain. Operator fills tier/type/best-for/
 *      effects/COA per row.
 *   3. Save (Slice 2C, stub here): POSTs the reviewed payload to
 *      /admin/receiving/save which creates the products + variants.
 *
 * Drafts live in React state only — no DB persistence between extract
 * and save (decision: in-memory; faster to ship, refresh = re-extract).
 */

/* ---------- Inline icon (sidebar) ---------- */
const TruckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 3h15v13H1z" />
    <path d="M16 8h4l3 3v5h-7V8z" />
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
)

/* ---------- Brand-spec dropdown enums (5 tiers, 3 types, 3 best-for, 9 effects) ----------
 * Tiers are a fixed brand list of 5 — keys match the `flower_tier_prices`
 * settings shape. Type/best-for/effects are imported lists from the
 * mbs-attributes module (single source of truth there). Mirrored here as
 * string literals to avoid coupling the admin bundle to a server module. */
const TIER_OPTIONS = [
  { key: "classic", label: "Classic" },
  { key: "exotic",  label: "Exotic"  },
  { key: "super",   label: "Super"   },
  { key: "snow",    label: "Snow"    },
  { key: "rapper",  label: "Rapper"  },
] as const
type TierKey = typeof TIER_OPTIONS[number]["key"]

const STRAIN_TYPE_OPTIONS = ["Indica", "Sativa", "Hybrid"] as const
type StrainType = typeof STRAIN_TYPE_OPTIONS[number]

const BEST_FOR_OPTIONS = [
  { key: "day",     label: "Day"     },
  { key: "evening", label: "Evening" },
  { key: "night",   label: "Night"   },
] as const
type BestFor = typeof BEST_FOR_OPTIONS[number]["key"]

const EFFECT_OPTIONS = [
  "Chill", "Energy", "Relief", "Sleep", "Focus",
  "Grounded", "Creative", "Social", "Calm",
] as const
type Effect = typeof EFFECT_OPTIONS[number]

/* ---------- Types matching server-side ai-extraction.ts ---------- */
type ExtractedLineItem = {
  strainName: string
  quantityLb: number
  unitPricePerLb: number
}
type ExtractedSupplier = {
  name: string
  phone: string | null
  email: string | null
  address: string | null
}
type ExtractedInvoice = {
  supplier: ExtractedSupplier
  invoiceNumber: string
  invoiceDate: string
  lineItems: ExtractedLineItem[]
  shippingTotal: number
  subtotal: number | null
  total: number
  notes: string | null
}

/* Per-row review state — extends the extracted line item with the
 * operator's dropdown picks + COA file. */
type ReviewRow = {
  /* extracted (editable) */
  strainName: string
  quantityLb: number
  unitPricePerLb: number
  /* operator picks — null until selected, blocks Save */
  tier: TierKey | null
  strainType: StrainType | null
  bestFor: BestFor | null
  effects: Effect[]
  coaFile: File | null
}

type TierPriceMap = Record<TierKey, { qp: number; half: number; lb: number }>

/* ---------- Helpers ---------- */
const fmtMoney = (n: number) => `$${n.toFixed(2)}`
const fmtMoneyWhole = (n: number) => `$${Math.round(n).toLocaleString()}`

/** Spread the invoice's shipping cost across line items by lb-share.
 * Returns shipping $ per lb. Per spec §3.4 landed cost calculation. */
function shippingPerLb(invoice: ExtractedInvoice): number {
  const totalLb = invoice.lineItems.reduce((s, li) => s + (li.quantityLb || 0), 0)
  if (totalLb <= 0) return 0
  return invoice.shippingTotal / totalLb
}

function makeRows(invoice: ExtractedInvoice): ReviewRow[] {
  return invoice.lineItems.map((li) => ({
    strainName: li.strainName,
    quantityLb: li.quantityLb,
    unitPricePerLb: li.unitPricePerLb,
    tier: null,
    strainType: null,
    bestFor: null,
    effects: [],
    coaFile: null,
  }))
}

/* =========================================================
 * Upload view
 * ========================================================= */
const UploadView: React.FC<{
  onExtracted: (invoice: ExtractedInvoice, fileName: string, tokens: { in: number; out: number }) => void
}> = ({ onExtracted }) => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((f: File | null) => {
    setError(null)
    if (!f) { setFile(null); return }
    if (f.type !== "application/pdf") {
      setError(`Expected a PDF — got ${f.type || "unknown type"}`)
      return
    }
    if (f.size > 15 * 1024 * 1024) {
      setError(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB) — max 15 MB`)
      return
    }
    setFile(f)
  }, [])

  const submit = useCallback(async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append("invoice", file)
      const res = await fetch("/admin/receiving/extract", {
        method: "POST",
        credentials: "include",
        body: fd,
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? `Extract failed (${res.status})`)
      }
      toast.success("Invoice extracted", {
        description: `${json.data.lineItems.length} line items · ${json.tokensIn + json.tokensOut} tokens`,
      })
      onExtracted(json.data, json.fileName, { in: json.tokensIn, out: json.tokensOut })
    } catch (e: any) {
      setError(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }, [file, onExtracted])

  return (
    <div className="flex flex-col gap-4">
      <Heading level="h2">Upload Supplier Invoice</Heading>
      <Text className="text-ui-fg-subtle">
        Drop a supplier invoice PDF below. The AI will extract supplier info, invoice metadata,
        and per-strain line items. You'll review + add attributes (tier, type, effects) before
        creating products.
      </Text>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          handleFile(e.dataTransfer.files?.[0] ?? null)
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: dragOver ? "2px solid #0A0A0A" : "2px dashed #C9C3B2",
          background: dragOver ? "rgba(10,10,10,0.04)" : "#FAFAF7",
          padding: "48px 24px",
          textAlign: "center",
          cursor: "pointer",
          transition: "all 120ms ease",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          style={{ display: "none" }}
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <div className="flex flex-col gap-1">
            <Text size="large" weight="plus">{file.name}</Text>
            <Text size="small" className="text-ui-fg-subtle">
              {(file.size / 1024).toFixed(0)} KB · click or drop to replace
            </Text>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Text size="large" weight="plus">Drop a PDF here</Text>
            <Text size="small" className="text-ui-fg-subtle">or click to browse · max 15 MB</Text>
          </div>
        )}
      </div>

      {error && (
        <div style={{ border: "1.5px solid #B91C1C", padding: "12px 16px", background: "#fff" }}>
          <Text size="small" weight="plus" style={{ color: "#B91C1C" }}>{error}</Text>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!file || busy}
          onClick={submit}
        >
          {busy ? "Extracting…" : "Extract Invoice"}
        </Button>
      </div>
    </div>
  )
}

/* =========================================================
 * Review view (header + spreadsheet)
 * ========================================================= */
const ReviewView: React.FC<{
  invoice: ExtractedInvoice
  fileName: string
  tokens: { in: number; out: number }
  tierPrices: TierPriceMap | null
  onRestart: () => void
}> = ({ invoice: initialInvoice, fileName, tokens, tierPrices, onRestart }) => {
  const [invoice, setInvoice] = useState<ExtractedInvoice>(initialInvoice)
  const [rows, setRows] = useState<ReviewRow[]>(() => makeRows(initialInvoice))
  const [saving, setSaving] = useState(false)

  const shipPerLb = useMemo(() => shippingPerLb(invoice), [invoice])

  /* keep shipping spread accurate if operator edits qty inline */
  useEffect(() => {
    setInvoice((cur) => ({
      ...cur,
      lineItems: rows.map((r) => ({
        strainName: r.strainName,
        quantityLb: r.quantityLb,
        unitPricePerLb: r.unitPricePerLb,
      })),
    }))
  }, [rows])

  const allValid = rows.length > 0 && rows.every(
    (r) => r.tier && r.strainType && r.bestFor && r.strainName.trim() && r.quantityLb > 0,
  )

  const updateRow = useCallback((idx: number, patch: Partial<ReviewRow>) => {
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }, [])

  /* Brand spec caps card display at 2 effects, so we enforce the cap
   * here too. Clicking a third selection is a no-op; deselect first. */
  const MAX_EFFECTS = 2
  const toggleEffect = useCallback((idx: number, effect: Effect) => {
    setRows((cur) => cur.map((r, i) => {
      if (i !== idx) return r
      const has = r.effects.includes(effect)
      if (has) return { ...r, effects: r.effects.filter((e) => e !== effect) }
      if (r.effects.length >= MAX_EFFECTS) return r
      return { ...r, effects: [...r.effects, effect] }
    }))
  }, [])

  const onSave = useCallback(async () => {
    if (!allValid) return
    setSaving(true)
    try {
      /* Slice 2C will implement /admin/receiving/save — for now just stub
       * the request so the wiring is testable. */
      const payload = {
        supplier: invoice.supplier,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        shippingTotal: invoice.shippingTotal,
        total: invoice.total,
        rows: rows.map((r) => ({
          strainName: r.strainName.trim(),
          quantityLb: r.quantityLb,
          unitPricePerLb: r.unitPricePerLb,
          tier: r.tier,
          strainType: r.strainType,
          bestFor: r.bestFor,
          effects: r.effects,
          /* COA file isn't JSON-serializable — Slice 2C will switch this
           * to a multipart upload. For now, just send the file name. */
          coaFileName: r.coaFile?.name ?? null,
        })),
      }
      // eslint-disable-next-line no-console
      console.log("[receiving:save:stub]", payload)
      toast.info("Save handler coming in Slice 2C", {
        description: "Payload logged to console for now.",
      })
    } catch (e: any) {
      toast.error("Save failed", { description: e?.message ?? "Network error" })
    } finally {
      setSaving(false)
    }
  }, [allValid, invoice, rows])

  /* ---- header card ---- */
  return (
    <div className="flex flex-col gap-6">
      {/* Top bar */}
      <div className="flex justify-between items-center gap-4 flex-wrap">
        <div className="flex flex-col">
          <Heading level="h2">Review Invoice</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {fileName} · {tokens.in + tokens.out} tokens
          </Text>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onRestart}>Start Over</Button>
          <Button variant="primary" disabled={!allValid || saving} onClick={onSave}>
            {saving ? "Saving…" : `Save ${rows.length} Products`}
          </Button>
        </div>
      </div>

      {invoice.notes && (
        <div style={{ border: "1.5px solid #C98A00", padding: "10px 14px", background: "#fff" }}>
          <Text size="small" weight="plus" style={{ color: "#C98A00", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            AI Notes
          </Text>
          <Text size="small">{invoice.notes}</Text>
        </div>
      )}

      {/* Supplier + invoice meta */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-3" style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}>Supplier</Text>
          <Field label="Name">
            <Input value={invoice.supplier.name} onChange={(e) => setInvoice((c) => ({ ...c, supplier: { ...c.supplier, name: e.target.value } }))} />
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
            <Field label="Invoice #">
              <Input value={invoice.invoiceNumber} onChange={(e) => setInvoice((c) => ({ ...c, invoiceNumber: e.target.value }))} />
            </Field>
            <Field label="Date (YYYY-MM-DD)">
              <Input value={invoice.invoiceDate} onChange={(e) => setInvoice((c) => ({ ...c, invoiceDate: e.target.value }))} />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Shipping">
              <Input type="number" step="0.01" value={invoice.shippingTotal}
                onChange={(e) => setInvoice((c) => ({ ...c, shippingTotal: Number(e.target.value) || 0 }))} />
            </Field>
            <Field label="Subtotal">
              <Input type="number" step="0.01" value={invoice.subtotal ?? 0}
                onChange={(e) => setInvoice((c) => ({ ...c, subtotal: Number(e.target.value) || null }))} />
            </Field>
            <Field label="Total">
              <Input type="number" step="0.01" value={invoice.total}
                onChange={(e) => setInvoice((c) => ({ ...c, total: Number(e.target.value) || 0 }))} />
            </Field>
          </div>
          <div className="flex justify-between items-center" style={{ borderTop: "1px solid #E5E1D6", paddingTop: 8 }}>
            <Text size="small" className="text-ui-fg-subtle">Shipping spread</Text>
            <Text size="small" weight="plus" style={{ fontFamily: "monospace" }}>
              {fmtMoney(shipPerLb)} / lb
            </Text>
          </div>
        </div>
      </div>

      {/* Spreadsheet */}
      <div style={{ border: "1.5px solid #E5E1D6", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F3F1EA", borderBottom: "1.5px solid #0A0A0A" }}>
              <Th>Strain</Th>
              <Th>Qty (lb)</Th>
              <Th>Cost / lb</Th>
              <Th>Tier</Th>
              <Th>Type</Th>
              <Th>Best For</Th>
              <Th>Effects</Th>
              <Th>COA</Th>
              <Th align="right">Landed / lb</Th>
              <Th align="right">Suggested Sell (QP / Half / LB)</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const landedPerLb = (row.unitPricePerLb || 0) + shipPerLb
              const tp = row.tier && tierPrices ? tierPrices[row.tier] : null
              const isComplete = !!(row.tier && row.strainType && row.bestFor)
              return (
                <tr key={i} style={{
                  borderBottom: "1px solid #E5E1D6",
                  background: isComplete ? "rgba(84,148,2,0.04)" : "#fff",
                }}>
                  <Td>
                    <Input value={row.strainName}
                      onChange={(e) => updateRow(i, { strainName: e.target.value })} />
                  </Td>
                  <Td style={{ minWidth: 80 }}>
                    <Input type="number" step="0.01" value={row.quantityLb}
                      onChange={(e) => updateRow(i, { quantityLb: Number(e.target.value) || 0 })} />
                  </Td>
                  <Td style={{ minWidth: 100 }}>
                    <Input type="number" step="0.01" value={row.unitPricePerLb}
                      onChange={(e) => updateRow(i, { unitPricePerLb: Number(e.target.value) || 0 })} />
                  </Td>
                  <Td>
                    <Select value={row.tier ?? ""} onValueChange={(v) => updateRow(i, { tier: v as TierKey })}>
                      <Select.Trigger><Select.Value placeholder="—" /></Select.Trigger>
                      <Select.Content>
                        {TIER_OPTIONS.map((o) => (
                          <Select.Item key={o.key} value={o.key}>{o.label}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </Td>
                  <Td>
                    <Select value={row.strainType ?? ""} onValueChange={(v) => updateRow(i, { strainType: v as StrainType })}>
                      <Select.Trigger><Select.Value placeholder="—" /></Select.Trigger>
                      <Select.Content>
                        {STRAIN_TYPE_OPTIONS.map((o) => (
                          <Select.Item key={o} value={o}>{o}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </Td>
                  <Td>
                    <Select value={row.bestFor ?? ""} onValueChange={(v) => updateRow(i, { bestFor: v as BestFor })}>
                      <Select.Trigger><Select.Value placeholder="—" /></Select.Trigger>
                      <Select.Content>
                        {BEST_FOR_OPTIONS.map((o) => (
                          <Select.Item key={o.key} value={o.key}>{o.label}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </Td>
                  <Td style={{ minWidth: 200, maxWidth: 260 }}>
                    <div className="flex flex-wrap gap-1">
                      {EFFECT_OPTIONS.map((e) => {
                        const on = row.effects.includes(e)
                        const disabled = !on && row.effects.length >= 2
                        return (
                          <button
                            key={e}
                            type="button"
                            disabled={disabled}
                            onClick={() => toggleEffect(i, e)}
                            title={disabled ? "Max 2 effects per product" : undefined}
                            style={{
                              border: "1px solid #0A0A0A",
                              background: on ? "#0A0A0A" : "transparent",
                              color: on ? "#FAFAF7" : "#0A0A0A",
                              opacity: disabled ? 0.3 : 1,
                              fontSize: 11,
                              padding: "2px 6px",
                              fontFamily: "monospace",
                              textTransform: "uppercase",
                              cursor: disabled ? "not-allowed" : "pointer",
                            }}
                          >
                            {e}
                          </button>
                        )
                      })}
                    </div>
                    <Text size="xsmall" className="text-ui-fg-muted" style={{ marginTop: 4 }}>
                      {row.effects.length}/2 selected
                    </Text>
                  </Td>
                  <Td>
                    <CoaUpload
                      file={row.coaFile}
                      onChange={(f) => updateRow(i, { coaFile: f })}
                    />
                  </Td>
                  <Td align="right" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {fmtMoney(landedPerLb)}
                  </Td>
                  <Td align="right" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {tp
                      ? `${fmtMoneyWhole(tp.qp)} / ${fmtMoneyWhole(tp.half)} / ${fmtMoneyWhole(tp.lb)}`
                      : !row.tier
                        ? <span className="text-ui-fg-muted">— pick tier —</span>
                        : !tierPrices
                          ? <span style={{ color: "#C98A00" }} title="Run pnpm seed:settings or set them in MBS Settings → Tier Prices">— tier prices not configured —</span>
                          : <span style={{ color: "#C98A00" }}>— no price for {row.tier} —</span>}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer summary */}
      <div className="flex justify-between items-center" style={{ borderTop: "1px solid #E5E1D6", paddingTop: 12 }}>
        <div className="flex gap-4">
          <Badge color={allValid ? "green" : "orange"}>
            {allValid ? "Ready to save" : `${rows.filter((r) => !(r.tier && r.strainType && r.bestFor)).length} rows incomplete`}
          </Badge>
          <Text size="small" className="text-ui-fg-subtle">
            {rows.length} products · {rows.reduce((s, r) => s + r.quantityLb, 0).toFixed(2)} lb total
          </Text>
        </div>
        <Button variant="primary" disabled={!allValid || saving} onClick={onSave}>
          {saving ? "Saving…" : `Save ${rows.length} Products`}
        </Button>
      </div>
    </div>
  )
}

/* ---------- COA file picker (small inline) ---------- */
const CoaUpload: React.FC<{ file: File | null; onChange: (f: File | null) => void }> = ({ file, onChange }) => {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: "none" }}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <button type="button" onClick={() => onChange(null)}
          style={{ background: "transparent", border: "1px solid #0A0A0A", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={`${file.name} — click to remove`}
        >
          ✓ {file.name.length > 14 ? file.name.slice(0, 12) + "…" : file.name}
        </button>
      ) : (
        <button type="button" onClick={() => ref.current?.click()}
          style={{ background: "transparent", border: "1px dashed #C9C3B2", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer" }}
        >
          + COA
        </button>
      )}
    </div>
  )
}

/* ---------- Small atoms ---------- */
const Th: React.FC<{ children: React.ReactNode; align?: "left" | "right" }> = ({ children, align = "left" }) => (
  <th style={{
    padding: "10px 8px",
    textAlign: align,
    fontFamily: "monospace",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
  }}>
    {children}
  </th>
)
const Td: React.FC<{ children: React.ReactNode; align?: "left" | "right"; style?: React.CSSProperties }> = ({ children, align = "left", style }) => (
  <td style={{ padding: "8px", textAlign: align, verticalAlign: "middle", ...style }}>{children}</td>
)
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <Label size="xsmall" weight="plus">{label}</Label>
    {children}
  </div>
)

/* =========================================================
 * Page shell
 * ========================================================= */
const ReceivingPage = () => {
  const [extracted, setExtracted] = useState<{
    invoice: ExtractedInvoice
    fileName: string
    tokens: { in: number; out: number }
  } | null>(null)
  const [tierPrices, setTierPrices] = useState<TierPriceMap | null>(null)

  /* Fetch tier prices once on mount so the review table can show
   * suggested-sell columns. Falls back to null silently — admin can
   * still review + save without them. */
  useEffect(() => {
    let cancelled = false
    fetch("/admin/mbs/settings", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const row = (j.settings ?? []).find((s: any) => s.key === "flower_tier_prices")
        if (row?.value) setTierPrices(row.value as TierPriceMap)
      })
      .catch(() => { /* ignore — tier prices are optional UI */ })
    return () => { cancelled = true }
  }, [])

  return (
    <Container className="flex flex-col gap-6 p-6">
      <Heading level="h1">Receiving</Heading>
      {extracted ? (
        <ReviewView
          invoice={extracted.invoice}
          fileName={extracted.fileName}
          tokens={extracted.tokens}
          tierPrices={tierPrices}
          onRestart={() => setExtracted(null)}
        />
      ) : (
        <UploadView
          onExtracted={(invoice, fileName, tokens) =>
            setExtracted({ invoice, fileName, tokens })
          }
        />
      )}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Receiving",
  icon: TruckIcon,
})

export default ReceivingPage

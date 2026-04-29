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
  strainType: StrainType | null
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

/* Serializable COA state — replaces the old File-object approach.
 * Files upload immediately on pick (per-row or bulk drop), so by
 * the time we save a draft or finalize, every row's coa is already
 * a URL on MinIO/local storage. State machine handles error/retry. */
type CoaState =
  | { state: "idle" }
  | { state: "uploading"; originalName: string }
  | { state: "ready"; url: string; originalName: string; mimeType: string }
  | { state: "error"; originalName: string; error: string }

/* Per-row review state — extends the extracted line item with the
 * operator's dropdown picks + COA upload state. */
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
  coa: CoaState
  /* Compliance values typed from the COA. Stored as strings since
   * Medusa's model.number is integer-only — the mbs-attributes
   * model uses text() for decimal-friendly storage. Operator can
   * type manually OR auto-extract from the uploaded COA via AI. */
  thcaPercent: string
  totalCannabinoidsPercent: string
  /* Free-form AI commentary from the COA extractor — usually null,
   * but flags lab format quirks like "decarbed Total THC reported
   * instead of raw cannabinoid sum". Surfaced as a ⚠ tooltip in the
   * THCa cell so the operator can review. */
  coaNotes: string | null
}

type TierPriceMap = Record<TierKey, { qp: number; half: number; lb: number }>

/* Persisted draft summary — what shows in the resume cards. Cheap to
 * keep in sync (rewritten on every save). */
type DraftSummary = {
  fileName: string
  supplierName: string
  invoiceNumber: string
  lineItemCount: number
  completeRows: number
}

type DraftRow = {
  id: string
  payload: any
  summary: DraftSummary
  created_at: string
  updated_at: string
}

/* Shape we serialize into draft.payload — matches what review state
 * needs to be rehydrated. Rows are fully JSON-safe now (CoaState is
 * a discriminated union of plain objects). */
type DraftPayload = {
  invoice: ExtractedInvoice
  fileName: string
  tokens: { in: number; out: number }
  rows: ReviewRow[]
}

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

/* Industry-canonical mapping: sativa-dominant strains skew uplifting/
 * daytime, indica skew sedating/nighttime, hybrids land in the
 * evening middle. Operator can override per row. */
const TYPE_TO_BEST_FOR: Record<StrainType, BestFor> = {
  Sativa: "day",
  Hybrid: "evening",
  Indica: "night",
}

function makeRows(invoice: ExtractedInvoice): ReviewRow[] {
  return invoice.lineItems.map((li) => {
    const strainType = li.strainType ?? null
    const bestFor = strainType ? TYPE_TO_BEST_FOR[strainType] : null
    return {
      strainName: li.strainName,
      quantityLb: li.quantityLb,
      unitPricePerLb: li.unitPricePerLb,
      tier: null,
      strainType,
      bestFor,
      effects: [],
      coa: { state: "idle" },
      thcaPercent: "",
      totalCannabinoidsPercent: "",
      coaNotes: null,
    }
  })
}

/* =========================================================
 * Upload view
 * ========================================================= */
const UploadView: React.FC<{
  onExtracted: (invoice: ExtractedInvoice, fileName: string, tokens: { in: number; out: number }) => void
  onResumeDraft: (draft: DraftRow) => void
}> = ({ onExtracted, onResumeDraft }) => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /* Resumable drafts list — fetched on mount, refreshed when a draft
   * is deleted from this view. */
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [draftsLoading, setDraftsLoading] = useState(true)
  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true)
    try {
      const res = await fetch("/admin/receiving/drafts", { credentials: "include" })
      if (!res.ok) throw new Error()
      const json = await res.json()
      setDrafts(json.drafts ?? [])
    } catch { /* silent — drafts are optional */ }
    finally { setDraftsLoading(false) }
  }, [])
  useEffect(() => { loadDrafts() }, [loadDrafts])

  const deleteDraft = useCallback(async (id: string) => {
    if (!confirm("Discard this draft? Cannot be undone.")) return
    const res = await fetch(`/admin/receiving/drafts/${id}`, {
      method: "DELETE", credentials: "include",
    })
    if (res.ok) {
      toast.success("Draft discarded")
      loadDrafts()
    } else {
      toast.error("Failed to discard draft")
    }
  }, [loadDrafts])

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
    <div className="flex flex-col gap-6">
      {/* Resume drafts — only renders when drafts exist */}
      {!draftsLoading && drafts.length > 0 && (
        <div className="flex flex-col gap-3">
          <Heading level="h2">Resume Drafts</Heading>
          <div className="flex flex-col gap-2">
            {drafts.map((d) => (
              <DraftCard key={d.id} draft={d} onResume={() => onResumeDraft(d)} onDiscard={() => deleteDraft(d.id)} />
            ))}
          </div>
        </div>
      )}

      <Heading level="h2">{drafts.length > 0 ? "Or Upload a New Invoice" : "Upload Supplier Invoice"}</Heading>
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
  /* When resuming, the draft's persisted rows replace the freshly-extracted
   * defaults. coaFile is always null for restored rows (operator re-attaches). */
  initialRows?: ReviewRow[]
  /* If set, Save Draft updates this draft. Otherwise, first save creates one. */
  initialDraftId?: string | null
  onRestart: () => void
}> = ({ invoice: initialInvoice, fileName, tokens, tierPrices, initialRows, initialDraftId, onRestart }) => {
  const [invoice, setInvoice] = useState<ExtractedInvoice>(initialInvoice)
  const [rows, setRows] = useState<ReviewRow[]>(() => initialRows ?? makeRows(initialInvoice))
  const [saving, setSaving] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(initialDraftId ? new Date() : null)
  /* Selected row indices for bulk-fill. Set instead of array for
   * cheap has/add/delete. Bulk dropdowns appear when size > 0. */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /* Indices currently being AI-parsed (THCa/Cann from COA). Drives
   * the spinner state on per-row buttons + bulk progress count. */
  const [coaParsing, setCoaParsing] = useState<Set<number>>(new Set())

  const shipPerLb = useMemo(() => shippingPerLb(invoice), [invoice])

  /* keep shipping spread accurate if operator edits qty inline */
  useEffect(() => {
    setInvoice((cur) => ({
      ...cur,
      lineItems: rows.map((r) => ({
        strainName: r.strainName,
        quantityLb: r.quantityLb,
        unitPricePerLb: r.unitPricePerLb,
        strainType: r.strainType,
      })),
    }))
  }, [rows])

  /* Per-row completeness — every field the operator owns must be
   * filled (or auto-filled by AI). Drives both the row tint
   * (orange = missing, green = complete) and the Save-button gate.
   *
   * Required: strainName, qty, tier, type, bestFor, thca %, cann %,
   * COA file uploaded. Effects are intentionally optional (the brand
   * card shows max 2; zero is allowed at receiving). */
  const isRowComplete = useCallback((r: ReviewRow): boolean => {
    return !!(
      r.strainName.trim() &&
      r.quantityLb > 0 &&
      r.tier &&
      r.strainType &&
      r.bestFor &&
      r.thcaPercent.trim() &&
      r.totalCannabinoidsPercent.trim() &&
      r.coa.state === "ready"
    )
  }, [])
  const allValid = rows.length > 0 && rows.every(isRowComplete)

  const updateRow = useCallback((idx: number, patch: Partial<ReviewRow>) => {
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }, [])

  /* ---- Selection helpers ---- */
  const toggleRow = useCallback((idx: number) => {
    setSelected((cur) => {
      const next = new Set(cur)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }, [])
  const toggleAll = useCallback(() => {
    setSelected((cur) => cur.size === rows.length ? new Set() : new Set(rows.map((_, i) => i)))
  }, [rows.length])
  const clearSelection = useCallback(() => setSelected(new Set()), [])

  /* Apply a partial patch to every selected row at once. Used by the
   * bulk toolbar dropdowns. After applying, selection is cleared so
   * the toolbar disappears (operator's signal that the bulk op landed). */
  const bulkApply = useCallback((patch: Partial<ReviewRow>) => {
    if (selected.size === 0) return
    setRows((cur) => cur.map((r, i) => selected.has(i) ? { ...r, ...patch } : r))
    setSelected(new Set())
  }, [selected])

  /* AI extraction of THCa/Cann% from one row's already-uploaded COA.
   * No-op if the row has no COA ready. Updates the spinner Set so the
   * UI shows feedback. Returns a result tuple so the bulk caller can
   * report counts. */
  const parseCoaForRow = useCallback(async (idx: number): Promise<"ok" | "skipped" | "error"> => {
    const row = rows[idx]
    if (!row || row.coa.state !== "ready") return "skipped"
    setCoaParsing((cur) => { const next = new Set(cur); next.add(idx); return next })
    try {
      const res = await fetch("/admin/receiving/coa-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ coaUrl: (row.coa as any).url }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error ?? `Parse failed (${res.status})`)
      setRows((cur) => cur.map((r, i) => i === idx ? {
        ...r,
        thcaPercent: json.thcaPercent != null ? String(json.thcaPercent) : r.thcaPercent,
        totalCannabinoidsPercent: json.totalCannabinoidsPercent != null ? String(json.totalCannabinoidsPercent) : r.totalCannabinoidsPercent,
        coaNotes: json.notes ?? null,
      } : r))
      return "ok"
    } catch (e: any) {
      toast.error(`COA parse failed for ${row.strainName}`, { description: e?.message ?? "Network error" })
      return "error"
    } finally {
      setCoaParsing((cur) => { const next = new Set(cur); next.delete(idx); return next })
    }
  }, [rows])

  /* Bulk: run extraction on every row that has a COA but lacks both
   * percentages. Bounded concurrency keeps Anthropic happy + the
   * browser network panel readable. Promise-pool pattern. */
  const parseAllCoas = useCallback(async () => {
    const targets = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.coa.state === "ready" && (!r.thcaPercent.trim() || !r.totalCannabinoidsPercent.trim()))
      .map(({ i }) => i)
    if (targets.length === 0) {
      toast.info("Nothing to extract", { description: "Every row with a COA already has THCa% and Cann% filled." })
      return
    }
    const CONCURRENCY = 6
    let parsed = 0
    let failed = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const myIdx = targets[cursor++]
        const result = await parseCoaForRow(myIdx)
        if (result === "ok") parsed += 1
        else if (result === "error") failed += 1
      }
    }
    const t0 = Date.now()
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    toast.success(`Auto-fill complete`, {
      description: `${parsed} parsed · ${failed} failed · ${elapsed}s`,
    })
  }, [rows, parseCoaForRow])

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

  /* Save (or update) the draft. Rows are fully JSON-safe (COA state
   * is { state, url?, originalName? }) so they round-trip cleanly. */
  const onSaveDraft = useCallback(async () => {
    setSavingDraft(true)
    try {
      const payload: DraftPayload = {
        invoice,
        fileName,
        tokens,
        rows,
      }
      const summary: DraftSummary = {
        fileName,
        supplierName: invoice.supplier.name,
        invoiceNumber: invoice.invoiceNumber,
        lineItemCount: rows.length,
        completeRows: rows.filter((r) => isRowComplete(r)).length,
      }
      const url = draftId ? `/admin/receiving/drafts/${draftId}` : "/admin/receiving/drafts"
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ payload, summary }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.message ?? `Save failed (${res.status})`)
      if (!draftId) setDraftId(json.draft.id)
      setLastSavedAt(new Date())
      toast.success(draftId ? "Draft updated" : "Draft saved", {
        description: "You can close this tab and resume later.",
      })
    } catch (e: any) {
      toast.error("Couldn't save draft", { description: e?.message ?? "Network error" })
    } finally {
      setSavingDraft(false)
    }
  }, [draftId, invoice, fileName, tokens, rows])

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
          coaUrl: r.coa.state === "ready" ? r.coa.url : null,
          coaOriginalName: r.coa.state === "ready" ? r.coa.originalName : null,
          thcaPercent: r.thcaPercent.trim() || null,
          totalCannabinoidsPercent: r.totalCannabinoidsPercent.trim() || null,
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
            {lastSavedAt && <> · draft saved {formatRelativeTime(lastSavedAt)}</>}
          </Text>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onRestart}>Start Over</Button>
          <Button variant="secondary" disabled={savingDraft} onClick={onSaveDraft}>
            {savingDraft ? "Saving…" : draftId ? "Update Draft" : "Save Draft"}
          </Button>
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

      {/* Bulk AI auto-fill from COAs — one click parses every row's COA */}
      <div className="flex justify-end items-center gap-2" style={{ marginTop: -4 }}>
        <Text size="xsmall" className="text-ui-fg-muted" style={{ fontFamily: "monospace" }}>
          {coaParsing.size > 0 ? `parsing ${coaParsing.size}…` : `~$0.011 / row`}
        </Text>
        <Button
          variant="secondary"
          size="small"
          disabled={coaParsing.size > 0}
          onClick={parseAllCoas}
          title="Calls Claude Sonnet on each uploaded COA to extract THCa% + Total Cannabinoids%"
        >
          AI: Auto-fill THCa / Cann from COAs
        </Button>
      </div>

      {/* Bulk COA drop zone — multi-file upload, auto-matched by strain name */}
      <BulkCoaDropzone
        rows={rows}
        onApply={(stagedMap) => {
          /* Mark every staged row as uploading so the UI flips
           * immediately, even before the network round-trip. */
          setRows((cur) => cur.map((r, i) => {
            const staged = stagedMap.get(i)
            return staged
              ? { ...r, coa: { state: "uploading", originalName: staged.file.name } }
              : r
          }))
        }}
        onResultPerFile={(rowIdx, result) => {
          setRows((cur) => cur.map((r, i) => {
            if (i !== rowIdx) return r
            if ("error" in result) {
              return { ...r, coa: { state: "error", originalName: result.originalName, error: result.error } }
            }
            return {
              ...r,
              coa: { state: "ready", url: result.url, originalName: result.originalName, mimeType: result.mimeType },
            }
          }))
        }}
      />

      {/* Bulk-fill toolbar — appears when 1+ rows are selected */}
      {selected.size > 0 && (
        <div style={{
          background: "#0A0A0A", color: "#FAFAF7", padding: "10px 14px",
          display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
          position: "sticky", top: 0, zIndex: 20,
        }}>
          <Text size="small" weight="plus" style={{ color: "#FAFAF7", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            {selected.size} selected
          </Text>
          <span style={{ color: "#888", fontSize: 12 }}>Apply to selected:</span>
          <BulkSelect placeholder="Tier" options={TIER_OPTIONS.map((o) => ({ value: o.key, label: o.label }))} onPick={(v) => bulkApply({ tier: v as TierKey })} />
          <BulkSelect placeholder="Type" options={STRAIN_TYPE_OPTIONS.map((o) => ({ value: o, label: o }))} onPick={(v) => bulkApply({ strainType: v as StrainType })} />
          <BulkSelect placeholder="Best For" options={BEST_FOR_OPTIONS.map((o) => ({ value: o.key, label: o.label }))} onPick={(v) => bulkApply({ bestFor: v as BestFor })} />
          <span style={{ flex: 1 }} />
          <button type="button" onClick={clearSelection}
            style={{ background: "transparent", border: "1px solid #FAFAF7", color: "#FAFAF7", padding: "4px 12px", fontSize: 11, fontFamily: "monospace", textTransform: "uppercase", cursor: "pointer" }}>
            Clear
          </button>
        </div>
      )}

      {/* Spreadsheet */}
      <div style={{ border: "1.5px solid #E5E1D6", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F3F1EA", borderBottom: "1.5px solid #0A0A0A" }}>
              <Th><CheckBox checked={selected.size === rows.length && rows.length > 0} indeterminate={selected.size > 0 && selected.size < rows.length} onChange={toggleAll} /></Th>
              <Th>Strain</Th>
              <Th>Qty (lb)</Th>
              <Th>Cost / lb</Th>
              <Th>Tier</Th>
              <Th>Type</Th>
              <Th>Best For</Th>
              <Th align="right">THCa %</Th>
              <Th align="right">Cann %</Th>
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
              const isComplete = isRowComplete(row)
              const isSelected = selected.has(i)
              /* Row tint priority: selection (red) > completeness
               * (green = ready, orange = needs work). White is never
               * shown — operator can always tell at a glance which
               * rows still need attention. */
              const rowBg = isSelected
                ? "rgba(217,55,55,0.06)"
                : isComplete
                  ? "rgba(84,148,2,0.06)"     /* tier-exotic green */
                  : "rgba(201,138,0,0.06)"    /* warning amber */
              return (
                <tr key={i} style={{
                  borderBottom: "1px solid #E5E1D6",
                  background: rowBg,
                }}>
                  <Td>
                    <CheckBox checked={isSelected} onChange={() => toggleRow(i)} />
                  </Td>
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
                  <Td align="right" style={{ minWidth: 90 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                      <Input type="number" step="0.01" placeholder="—"
                        value={row.thcaPercent}
                        onChange={(e) => updateRow(i, { thcaPercent: e.target.value })}
                        style={{ textAlign: "right" }} />
                      <CoaAiButton
                        canParse={row.coa.state === "ready"}
                        parsing={coaParsing.has(i)}
                        onClick={() => parseCoaForRow(i)}
                      />
                    </div>
                    {row.coaNotes && (
                      <span title={row.coaNotes}
                        style={{ display: "inline-block", marginTop: 2, color: "#C98A00", fontSize: 11, cursor: "help" }}>
                        ⚠ AI note
                      </span>
                    )}
                  </Td>
                  <Td align="right" style={{ minWidth: 70 }}>
                    <Input type="number" step="0.01" placeholder="—"
                      value={row.totalCannabinoidsPercent}
                      onChange={(e) => updateRow(i, { totalCannabinoidsPercent: e.target.value })}
                      style={{ textAlign: "right" }} />
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
                      coa={row.coa}
                      onChange={(c) => updateRow(i, { coa: c })}
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
            {allValid ? "Ready to save" : `${rows.filter((r) => !isRowComplete(r)).length} rows incomplete`}
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

/* ---------- Per-row AI extract trigger ----------
 * Tiny button that lives in the THCa cell. Disabled when there's no
 * COA to parse, shows a spinner glyph while parsing. Title hover tells
 * the operator what it does + the cost. */
const CoaAiButton: React.FC<{
  canParse: boolean
  parsing: boolean
  onClick: () => void
}> = ({ canParse, parsing, onClick }) => {
  const disabled = !canParse || parsing
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        !canParse ? "Upload a COA first"
          : parsing ? "Parsing COA…"
          : "Auto-fill THCa% + Cann% from this row's COA (~$0.011)"
      }
      style={{
        background: parsing ? "#C98A00" : disabled ? "transparent" : "#0A0A0A",
        color: parsing || !disabled ? "#FAFAF7" : "#C9C3B2",
        border: "1px solid",
        borderColor: parsing ? "#C98A00" : disabled ? "#E5E1D6" : "#0A0A0A",
        padding: "2px 6px",
        fontSize: 10,
        fontFamily: "monospace",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        cursor: disabled ? "not-allowed" : "pointer",
        minWidth: 30,
      }}
    >
      {parsing ? "…" : "AI"}
    </button>
  )
}

/* ---------- COA upload helper ----------
 * One-shot multipart upload to the admin endpoint. Returns parallel
 * lists of successes and per-file errors so the caller can apply the
 * wins and surface the losses. */
async function uploadCoas(files: File[]): Promise<{
  ok: Array<{ url: string; originalName: string; mimeType: string }>
  errors: Array<{ originalName: string; error: string }>
}> {
  const fd = new FormData()
  for (const f of files) fd.append("coas", f)
  const res = await fetch("/admin/receiving/coa-upload", {
    method: "POST",
    credentials: "include",
    body: fd,
  })
  const json = await res.json()
  if (!res.ok || !json.ok) {
    throw new Error(json?.error ?? `Upload failed (${res.status})`)
  }
  return { ok: json.files ?? [], errors: json.errors ?? [] }
}

/* ---------- Per-row COA picker (uploads on pick) ----------
 * State machine: idle → uploading → ready | error. Click ready to
 * open the persisted URL in a new tab; click error to retry. */
const CoaUpload: React.FC<{
  coa: CoaState
  onChange: (c: CoaState) => void
}> = ({ coa, onChange }) => {
  const ref = useRef<HTMLInputElement>(null)

  const upload = useCallback(async (file: File) => {
    onChange({ state: "uploading", originalName: file.name })
    try {
      const result = await uploadCoas([file])
      const ok = result.ok[0]
      const err = result.errors[0]
      if (ok) {
        onChange({ state: "ready", url: ok.url, originalName: ok.originalName, mimeType: ok.mimeType })
      } else {
        onChange({ state: "error", originalName: file.name, error: err?.error ?? "Upload failed" })
      }
    } catch (e: any) {
      onChange({ state: "error", originalName: file.name, error: e?.message ?? "Network error" })
    }
  }, [onChange])

  const truncate = (s: string) => s.length > 14 ? s.slice(0, 12) + "…" : s

  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload(f)
          if (ref.current) ref.current.value = ""  /* allow re-pick of same file after error */
        }}
      />
      {coa.state === "idle" && (
        <button type="button" onClick={() => ref.current?.click()}
          style={{ background: "transparent", border: "1px dashed #C9C3B2", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer" }}>
          + COA
        </button>
      )}
      {coa.state === "uploading" && (
        <span style={{ border: "1px solid #C98A00", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", color: "#C98A00", display: "inline-block", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={`Uploading ${coa.originalName}…`}>
          ↑ {truncate(coa.originalName)}
        </span>
      )}
      {coa.state === "ready" && (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <a href={coa.url} target="_blank" rel="noopener noreferrer"
            style={{ background: "transparent", border: "1px solid #0A0A0A", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#0A0A0A", textDecoration: "none" }}
            title={`${coa.originalName} — click to open`}>
            ✓ {truncate(coa.originalName)}
          </a>
          <button type="button" onClick={() => onChange({ state: "idle" })}
            style={{ background: "transparent", border: "none", color: "#B91C1C", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: 1 }}
            title="Remove COA">
            ×
          </button>
        </span>
      )}
      {coa.state === "error" && (
        <button type="button" onClick={() => ref.current?.click()}
          style={{ background: "transparent", border: "1px solid #B91C1C", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer", color: "#B91C1C", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={coa.error}>
          × retry — {truncate(coa.originalName)}
        </button>
      )}
    </div>
  )
}

/* ---------- Bulk COA drop zone ----------
 * Drops/picks N files at once; each is fuzzy-matched to a row by
 * strain name, then uploaded in parallel. Already-attached rows are
 * skipped (operator removes the existing COA first to overwrite).
 *
 * Match algorithm: normalize both sides (lowercase, alphanum-only),
 * then a row matches a file iff the file's normalized name CONTAINS
 * the row's normalized strainName. First file per row wins to avoid
 * double-assignment; leftover files surface in the result toast for
 * manual placement.
 */
const BulkCoaDropzone: React.FC<{
  rows: ReviewRow[]
  onApply: (matches: Map<number, { file: File; result: "uploading" }>, unmatched: File[]) => void
  onResultPerFile: (rowIdx: number, result: { url: string; originalName: string; mimeType: string } | { error: string; originalName: string }) => void
}> = ({ rows, onApply, onResultPerFile }) => {
  const ref = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)

    /* 1. Match files to rows by name. Skip rows that already have a
     *    COA in any non-idle state. */
    const matches = new Map<number, File>()
    const usedFiles = new Set<File>()
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].coa.state !== "idle") continue
      const rowKey = normalizeForMatch(rows[i].strainName)
      if (!rowKey) continue
      for (const f of files) {
        if (usedFiles.has(f)) continue
        if (normalizeForMatch(f.name).includes(rowKey)) {
          matches.set(i, f)
          usedFiles.add(f)
          break
        }
      }
    }
    const unmatched = files.filter((f) => !usedFiles.has(f))

    /* 2. Tell the parent which rows are about to be busy so the UI
     *    flips to "uploading" immediately. */
    const stagedMap = new Map<number, { file: File; result: "uploading" }>()
    matches.forEach((f, i) => stagedMap.set(i, { file: f, result: "uploading" }))
    onApply(stagedMap, unmatched)

    /* 3. Send all matched files in one multipart request. The server
     *    returns parallel ok/errors lists keyed by originalName. */
    if (matches.size > 0) {
      try {
        const result = await uploadCoas(Array.from(matches.values()))
        /* Index server results by originalName for lookup. */
        const byName = new Map<string, { url: string; originalName: string; mimeType: string }>()
        for (const r of result.ok) byName.set(r.originalName, r)
        const errByName = new Map<string, string>()
        for (const e of result.errors) errByName.set(e.originalName, e.error)

        matches.forEach((file, rowIdx) => {
          const ok = byName.get(file.name)
          if (ok) {
            onResultPerFile(rowIdx, ok)
          } else {
            onResultPerFile(rowIdx, { error: errByName.get(file.name) ?? "Upload failed", originalName: file.name })
          }
        })

        toast.success(`Uploaded ${result.ok.length} of ${matches.size} COAs`, {
          description:
            unmatched.length > 0 ? `${unmatched.length} unmatched: ${unmatched.slice(0, 3).map((f) => f.name).join(", ")}${unmatched.length > 3 ? "…" : ""}` : undefined,
        })
      } catch (e: any) {
        matches.forEach((file, rowIdx) => {
          onResultPerFile(rowIdx, { error: e?.message ?? "Upload failed", originalName: file.name })
        })
        toast.error("Bulk upload failed", { description: e?.message ?? "Network error" })
      }
    } else if (unmatched.length > 0) {
      toast.warning(`No matches — ${unmatched.length} unmatched files`, {
        description: unmatched.slice(0, 3).map((f) => f.name).join(", ") + (unmatched.length > 3 ? "…" : ""),
      })
    }

    setBusy(false)
  }, [rows, onApply, onResultPerFile])

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFiles(Array.from(e.dataTransfer.files ?? []))
      }}
      onClick={() => ref.current?.click()}
      style={{
        border: dragOver ? "2px solid #0A0A0A" : "1.5px dashed #C9C3B2",
        background: dragOver ? "rgba(10,10,10,0.04)" : "#FAFAF7",
        padding: "16px 20px",
        textAlign: "center",
        cursor: busy ? "wait" : "pointer",
        opacity: busy ? 0.6 : 1,
        transition: "all 120ms ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <input
        ref={ref}
        type="file"
        accept="application/pdf,image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleFiles(Array.from(e.target.files ?? []))}
      />
      <Text size="small" weight="plus" style={{ fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        {busy ? "Uploading…" : "Drop COAs here — auto-matched to rows by strain name"}
      </Text>
    </div>
  )
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/* ---------- Draft resume card ---------- */
const DraftCard: React.FC<{
  draft: DraftRow
  onResume: () => void
  onDiscard: () => void
}> = ({ draft, onResume, onDiscard }) => {
  const s = draft.summary || ({} as DraftSummary)
  const updated = new Date(draft.updated_at)
  const ago = formatRelativeTime(updated)
  return (
    <div style={{ border: "1.5px solid #E5E1D6", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, background: "#FAFAF7" }}>
      <div className="flex flex-col" style={{ minWidth: 0, flex: 1 }}>
        <Text size="base" weight="plus" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {s.supplierName || "Unnamed supplier"} — {s.invoiceNumber || "no invoice #"}
        </Text>
        <Text size="small" className="text-ui-fg-subtle" style={{ fontFamily: "monospace" }}>
          {s.lineItemCount ?? 0} items · {s.completeRows ?? 0}/{s.lineItemCount ?? 0} complete · saved {ago} · {s.fileName ?? "?"}
        </Text>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onResume}>Resume</Button>
        <button type="button" onClick={onDiscard}
          style={{ background: "transparent", border: "1px solid #C9C3B2", color: "#B91C1C", padding: "8px 14px", fontSize: 13, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.05em", cursor: "pointer" }}>
          Discard
        </button>
      </div>
    </div>
  )
}

function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return d.toLocaleDateString()
}

/* ---------- Checkbox (square, brand-spec, supports indeterminate) ---------- */
const CheckBox: React.FC<{
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
}> = ({ checked, indeterminate, onChange }) => {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      style={{
        width: 16, height: 16, accentColor: "#0A0A0A",
        cursor: "pointer", margin: 0,
      }}
    />
  )
}

/* ---------- Bulk select dropdown (uncontrolled) ----------
 * Renders as a black "pill" with a placeholder. On pick, fires onPick
 * and resets to placeholder so the operator can re-use it for another
 * field (selection cleared by parent on apply, but the dropdown text
 * itself also resets). */
const BulkSelect: React.FC<{
  placeholder: string
  options: { value: string; label: string }[]
  onPick: (v: string) => void
}> = ({ placeholder, options, onPick }) => (
  <select
    value=""
    onChange={(e) => {
      if (e.target.value) {
        onPick(e.target.value)
        e.target.value = ""  /* reset for re-use */
      }
    }}
    style={{
      background: "transparent", color: "#FAFAF7",
      border: "1px solid #FAFAF7", padding: "4px 10px",
      fontSize: 12, fontFamily: "monospace", textTransform: "uppercase",
      letterSpacing: "0.05em", cursor: "pointer", minWidth: 90,
    }}
  >
    <option value="" style={{ background: "#0A0A0A" }}>{placeholder} ▾</option>
    {options.map((o) => (
      <option key={o.value} value={o.value} style={{ background: "#0A0A0A", textTransform: "none" }}>
        {o.label}
      </option>
    ))}
  </select>
)

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
    /* When resumed from a draft, these are non-null. The review view
     * uses them to skip the makeRows() defaults and to know which
     * draft id to update on subsequent saves. */
    initialRows?: ReviewRow[]
    draftId?: string | null
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
          initialRows={extracted.initialRows}
          initialDraftId={extracted.draftId ?? null}
          onRestart={() => setExtracted(null)}
        />
      ) : (
        <UploadView
          onExtracted={(invoice, fileName, tokens) =>
            setExtracted({ invoice, fileName, tokens })
          }
          onResumeDraft={(d) => {
            const p = d.payload as DraftPayload
            /* COA URLs persist in drafts now (uploaded immediately on
             * pick), so resumed rows pass through unchanged. Old
             * drafts created before this change may have rows with no
             * `coa` field — default those to idle. */
            const restoredRows: ReviewRow[] = p.rows.map((r) => ({
              ...r,
              coa: r.coa ?? { state: "idle" },
              thcaPercent: r.thcaPercent ?? "",
              totalCannabinoidsPercent: r.totalCannabinoidsPercent ?? "",
              coaNotes: r.coaNotes ?? null,
            }))
            setExtracted({
              invoice: p.invoice,
              fileName: p.fileName,
              tokens: p.tokens,
              initialRows: restoredRows,
              draftId: d.id,
            })
            toast.info("Draft resumed")
          }}
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

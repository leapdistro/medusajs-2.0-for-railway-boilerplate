import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Input, Label, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useMemo, useState } from "react"

/**
 * Pre-Roll Receiving — manual-entry-only page for receiving pre-roll
 * inventory (THC-A + Hashholes subcategories, single 30 ct box variant).
 *
 * Slice R3/R4 of receiving generalization (2026-05-14). Separate route
 * from flower receiving (/app/receiving) because:
 *   - Per Option A, no AI invoice extraction for pre-rolls yet
 *   - The review-grid columns differ (subcategory vs tier, qty boxes
 *     vs lb, operator-entered sell price vs tier-price lookup)
 *   - Manual entry only, no drafts in v1
 *
 * Backend uses profileKey="pre-roll" → flat pricing model → single
 * variant per strain with required_quantity=1 (1 box = 1 pool unit).
 */

const SUBCATEGORIES = [
  { key: "thc-a", label: "THC-A" },
  { key: "hashholes", label: "Hashholes" },
] as const

const STRAIN_TYPES = ["Indica", "Sativa", "Hybrid"] as const
const BEST_FOR = [
  { key: "day", label: "Day" },
  { key: "evening", label: "Evening" },
  { key: "night", label: "Night" },
] as const

const EFFECTS = [
  "Chill", "Energy", "Relief", "Sleep", "Focus",
  "Grounded", "Creative", "Social", "Calm",
] as const

type Subcategory = (typeof SUBCATEGORIES)[number]["key"]
type StrainType = (typeof STRAIN_TYPES)[number]
type BestFor = (typeof BEST_FOR)[number]["key"]

type CoaState =
  | { state: "idle" }
  | { state: "uploading" }
  | { state: "ready"; url: string; originalName: string; mimeType: string }
  | { state: "error"; message: string }

type Row = {
  strainName: string
  subcategory: Subcategory
  strainType: StrainType | ""
  bestFor: BestFor | ""
  effects: string[]
  quantityBoxes: number
  costPerBox: number
  sellPricePerBox: number
  coa: CoaState
  thcaPercent: string
  totalCannabinoidsPercent: string
}

const blankRow = (): Row => ({
  strainName: "",
  subcategory: "thc-a",
  strainType: "",
  bestFor: "",
  effects: [],
  quantityBoxes: 0,
  costPerBox: 0,
  sellPricePerBox: 0,
  coa: { state: "idle" },
  thcaPercent: "",
  totalCannabinoidsPercent: "",
})

const PreRollReceivingPage = () => {
  const [supplier, setSupplier] = useState({ name: "", phone: "", email: "", address: "" })
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [shippingTotal, setShippingTotal] = useState(0)
  const [rows, setRows] = useState<Row[]>([blankRow()])
  const [saving, setSaving] = useState(false)
  const [savedHistoryId, setSavedHistoryId] = useState<string | null>(null)
  const [savedSummary, setSavedSummary] = useState<{ created: number; restocked: number } | null>(null)
  const [savedPushedBillId, setSavedPushedBillId] = useState<string | null>(null)
  const [pushingToQbo, setPushingToQbo] = useState(false)

  const computedTotal = useMemo(() => {
    const subtotal = rows.reduce((s, r) => s + (r.quantityBoxes || 0) * (r.costPerBox || 0), 0)
    return subtotal + (shippingTotal || 0)
  }, [rows, shippingTotal])

  const allValid = useMemo(() => {
    if (!supplier.name?.trim() || !invoiceNumber.trim() || !invoiceDate) return false
    if (rows.length === 0) return false
    return rows.every((r) =>
      r.strainName.trim() &&
      r.subcategory &&
      r.strainType &&
      r.bestFor &&
      r.quantityBoxes > 0 &&
      r.costPerBox > 0 &&
      r.sellPricePerBox > 0 &&
      r.coa.state === "ready",
    )
  }, [supplier, invoiceNumber, invoiceDate, rows])

  const updateRow = useCallback((idx: number, patch: Partial<Row>) => {
    setRows((cur) => cur.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }, [])

  const addRow = () => setRows((cur) => [...cur, blankRow()])
  const deleteRow = (idx: number) => setRows((cur) => cur.filter((_, i) => i !== idx))

  const onPickCoa = async (idx: number, file: File | null) => {
    if (!file) return
    updateRow(idx, { coa: { state: "uploading" } })
    try {
      const fd = new FormData()
      fd.append("coas", file)
      const res = await fetch("/admin/receiving/coa-upload", {
        method: "POST",
        credentials: "include",
        body: fd,
      })
      const json = await res.json()
      const first = json?.files?.[0]
      if (!res.ok || !first) {
        const errMsg = json?.errors?.[0]?.error ?? json?.error ?? `HTTP ${res.status}`
        throw new Error(errMsg)
      }
      updateRow(idx, {
        coa: { state: "ready", url: first.url, originalName: first.originalName, mimeType: first.mimeType },
      })
    } catch (e: any) {
      updateRow(idx, { coa: { state: "error", message: e?.message ?? "Upload failed" } })
      toast.error("COA upload failed", { description: e?.message ?? "Network error" })
    }
  }

  const onSave = async () => {
    if (!allValid || saving) return
    setSaving(true)
    try {
      const body = {
        profileKey: "pre-roll",
        supplier,
        invoiceNumber,
        invoiceDate,
        shippingTotal,
        total: computedTotal,
        computedSubtotal: computedTotal - shippingTotal,
        computedTotal,
        rows: rows.map((r) => ({
          strainName: r.strainName.trim(),
          quantity: r.quantityBoxes,
          unitPrice: r.costPerBox,
          sellPrice: r.sellPricePerBox,
          tier: r.subcategory,
          strainType: r.strainType,
          bestFor: r.bestFor,
          effects: r.effects,
          coaUrl: r.coa.state === "ready" ? r.coa.url : null,
          coaOriginalName: r.coa.state === "ready" ? r.coa.originalName : null,
          thcaPercent: r.thcaPercent.trim() || null,
          totalCannabinoidsPercent: r.totalCannabinoidsPercent.trim() || null,
        })),
      }
      const res = await fetch("/admin/receiving/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok && !json?.summary) {
        throw new Error(json?.error ?? `Save failed (${res.status})`)
      }
      const s = json.summary as { created: number; restocked: number; failed: number }
      if (s.failed === 0) {
        toast.success("Pre-Roll receiving saved", {
          description: `${s.created} created · ${s.restocked} restocked`,
        })
        if (json.historyId) {
          setSavedHistoryId(json.historyId)
          setSavedSummary({ created: s.created, restocked: s.restocked })
        }
      } else {
        toast.warning(`${s.failed} of ${s.failed + s.created + s.restocked} rows failed`, {
          description: "See errors. Fix and re-save (succeeded rows skip-restock).",
        })
        /* Surface per-row errors inline by stamping the row with the error
         * string (lightweight — no need for the full status-pill machinery
         * of the flower review view in v1). */
        const results = (json.results ?? []) as Array<{ strainName: string; action: string; error?: string }>
        const errors = results
          .filter((r) => r.action === "failed")
          .map((r) => `${r.strainName}: ${r.error ?? "unknown error"}`)
          .join("\n")
        if (errors) {
          // eslint-disable-next-line no-console
          console.warn("[pre-roll receiving] partial-fail errors:\n" + errors)
        }
      }
    } catch (e: any) {
      toast.error("Save failed", { description: e?.message ?? "Network error" })
    } finally {
      setSaving(false)
    }
  }

  const onPushSavedToQbo = async () => {
    if (!savedHistoryId) return
    setPushingToQbo(true)
    try {
      const res = await fetch("/admin/qbo/push-bill", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId: savedHistoryId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `Push failed (${res.status})`)
      setSavedPushedBillId(json.billId)
      toast.success("Pushed to QuickBooks", {
        description: `Bill ${json.billId} · ${json.lines} line(s)`,
      })
    } catch (e: any) {
      toast.error("Push failed", { description: e?.message ?? "Network error" })
    } finally {
      setPushingToQbo(false)
    }
  }

  const onStartNew = () => {
    setSupplier({ name: "", phone: "", email: "", address: "" })
    setInvoiceNumber("")
    setInvoiceDate(new Date().toISOString().slice(0, 10))
    setShippingTotal(0)
    setRows([blankRow()])
    setSavedHistoryId(null)
    setSavedSummary(null)
    setSavedPushedBillId(null)
  }

  /* Success view replaces the form after a clean save — same shape as
   * the flower receiving success card. */
  if (savedHistoryId && savedSummary) {
    return (
      <Container className="flex flex-col gap-6 p-6">
        <Heading level="h1">Pre-Roll Receiving</Heading>
        <div style={{ border: "1.5px solid var(--tier-exotic, #549402)", background: "#fff", padding: 24 }}>
          <Heading level="h2" style={{ color: "var(--tier-exotic, #549402)" }}>✓ Receiving Saved</Heading>
          <Text size="base" className="text-ui-fg-subtle" style={{ marginTop: 4 }}>
            {invoiceNumber} · {savedSummary.created} created · {savedSummary.restocked} restocked
          </Text>
          <div className="flex gap-2 mt-4 flex-wrap items-center">
            {savedPushedBillId ? (
              <Badge color="purple">✓ Pushed to QBO · Bill {savedPushedBillId}</Badge>
            ) : (
              <Button variant="primary" isLoading={pushingToQbo} onClick={onPushSavedToQbo}>
                Push to QuickBooks
              </Button>
            )}
            <Button asChild variant="secondary">
              <a href={`/app/receiving/history/${savedHistoryId}`}>View in History</a>
            </Button>
            <Button asChild variant="secondary">
              <a href="/app/products">Open Products</a>
            </Button>
            <Button variant="transparent" onClick={onStartNew}>Start New Receiving</Button>
          </div>
        </div>
      </Container>
    )
  }

  return (
    <Container className="flex flex-col gap-6 p-6">
      <div className="flex justify-between items-center">
        <div>
          <Heading level="h1">Pre-Roll Receiving</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Manual entry — THC-A + Hashholes · 30 ct boxes. Use the main Receiving page for flower.
          </Text>
        </div>
        <Button variant="primary" disabled={!allValid || saving} onClick={onSave}>
          {saving ? "Saving…" : `Save ${rows.length} Product${rows.length === 1 ? "" : "s"}`}
        </Button>
      </div>

      {/* Supplier + invoice meta */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>
            Supplier
          </Text>
          <div className="flex flex-col gap-3">
            <Field label="Name (required)">
              <Input value={supplier.name} onChange={(e: any) => setSupplier({ ...supplier, name: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={supplier.phone} onChange={(e: any) => setSupplier({ ...supplier, phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input value={supplier.email} onChange={(e: any) => setSupplier({ ...supplier, email: e.target.value })} />
            </Field>
            <Field label="Address">
              <Textarea
                rows={2}
                value={supplier.address}
                onChange={(e: any) => setSupplier({ ...supplier, address: e.target.value })}
              />
            </Field>
          </div>
        </div>

        <div style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>
            Invoice
          </Text>
          <div className="flex flex-col gap-3">
            <Field label="Invoice # (required)">
              <Input value={invoiceNumber} onChange={(e: any) => setInvoiceNumber(e.target.value)} />
            </Field>
            <Field label="Date (required)">
              <Input type="date" value={invoiceDate} onChange={(e: any) => setInvoiceDate(e.target.value)} />
            </Field>
            <Field label="Shipping Total">
              <Input
                type="number"
                value={shippingTotal}
                onChange={(e: any) => setShippingTotal(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label="Computed Total">
              <div style={{ padding: "8px 0", fontFamily: "monospace" }}>${computedTotal.toFixed(2)}</div>
            </Field>
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-4">
        {rows.map((row, idx) => (
          <RowCard
            key={idx}
            row={row}
            idx={idx}
            onChange={(patch) => updateRow(idx, patch)}
            onDelete={rows.length > 1 ? () => deleteRow(idx) : undefined}
            onPickCoa={(file) => onPickCoa(idx, file)}
          />
        ))}
        <Button variant="secondary" onClick={addRow} className="self-start">
          + Add Row
        </Button>
      </div>
    </Container>
  )
}

/* ---- Helpers ---- */

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1">
    <Label size="xsmall" weight="plus">{label}</Label>
    {children}
  </div>
)

const RowCard: React.FC<{
  row: Row
  idx: number
  onChange: (patch: Partial<Row>) => void
  onDelete?: () => void
  onPickCoa: (file: File | null) => void
}> = ({ row, idx, onChange, onDelete, onPickCoa }) => {
  const toggleEffect = (effect: string) => {
    onChange({
      effects: row.effects.includes(effect)
        ? row.effects.filter((e) => e !== effect)
        : [...row.effects, effect],
    })
  }
  return (
    <div style={{ border: "1.5px solid #E5E1D6", padding: 16, background: "#fff" }}>
      <div className="flex justify-between items-center mb-3">
        <Text weight="plus" size="small" style={{ color: "#4A4A45" }}>Row #{idx + 1}</Text>
        {onDelete && (
          <Button variant="transparent" size="small" onClick={onDelete}>Delete</Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Strain Name">
          <Input value={row.strainName} onChange={(e: any) => onChange({ strainName: e.target.value })} />
        </Field>
        <Field label="Subcategory">
          <Select value={row.subcategory} onValueChange={(v) => onChange({ subcategory: v as Subcategory })}>
            <Select.Trigger><Select.Value /></Select.Trigger>
            <Select.Content>
              {SUBCATEGORIES.map((s) => (
                <Select.Item key={s.key} value={s.key}>{s.label}</Select.Item>
              ))}
            </Select.Content>
          </Select>
        </Field>
        <Field label="Strain Type">
          <Select value={row.strainType || ""} onValueChange={(v) => onChange({ strainType: v as StrainType })}>
            <Select.Trigger><Select.Value placeholder="—" /></Select.Trigger>
            <Select.Content>
              {STRAIN_TYPES.map((t) => (
                <Select.Item key={t} value={t}>{t}</Select.Item>
              ))}
            </Select.Content>
          </Select>
        </Field>

        <Field label="Best For">
          <Select value={row.bestFor || ""} onValueChange={(v) => onChange({ bestFor: v as BestFor })}>
            <Select.Trigger><Select.Value placeholder="—" /></Select.Trigger>
            <Select.Content>
              {BEST_FOR.map((b) => (
                <Select.Item key={b.key} value={b.key}>{b.label}</Select.Item>
              ))}
            </Select.Content>
          </Select>
        </Field>
        <Field label="Quantity (boxes)">
          <Input
            type="number"
            value={row.quantityBoxes || ""}
            onChange={(e: any) => onChange({ quantityBoxes: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Cost / Box">
          <Input
            type="number"
            value={row.costPerBox || ""}
            onChange={(e: any) => onChange({ costPerBox: Number(e.target.value) || 0 })}
          />
        </Field>

        <Field label="Sell Price / Box">
          <Input
            type="number"
            value={row.sellPricePerBox || ""}
            onChange={(e: any) => onChange({ sellPricePerBox: Number(e.target.value) || 0 })}
          />
        </Field>
        <Field label="THCa %">
          <Input value={row.thcaPercent} onChange={(e: any) => onChange({ thcaPercent: e.target.value })} />
        </Field>
        <Field label="Total Cannabinoids %">
          <Input
            value={row.totalCannabinoidsPercent}
            onChange={(e: any) => onChange({ totalCannabinoidsPercent: e.target.value })}
          />
        </Field>
      </div>

      {/* Effects + COA below the main grid */}
      <div className="mt-4 flex flex-col gap-3">
        <Field label="Effects (select any)">
          <div className="flex flex-wrap gap-2">
            {EFFECTS.map((e) => {
              const on = row.effects.includes(e)
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggleEffect(e)}
                  style={{
                    padding: "4px 10px",
                    border: "1.5px solid #0A0A0A",
                    background: on ? "#0A0A0A" : "transparent",
                    color: on ? "#fff" : "#0A0A0A",
                    fontFamily: "var(--font-display, sans-serif)",
                    fontSize: 12,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {e}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="COA (PDF, required)">
          {row.coa.state === "ready" ? (
            <div className="flex items-center gap-2">
              <Badge color="green">✓ {row.coa.originalName}</Badge>
              <Button variant="transparent" size="small" onClick={() => onChange({ coa: { state: "idle" } })}>
                Replace
              </Button>
            </div>
          ) : row.coa.state === "uploading" ? (
            <Text size="small" className="text-ui-fg-muted">Uploading…</Text>
          ) : row.coa.state === "error" ? (
            <div className="flex items-center gap-2">
              <Text size="small" style={{ color: "#B91C1C" }}>{row.coa.message}</Text>
              <input type="file" accept="application/pdf" onChange={(e) => onPickCoa(e.target.files?.[0] ?? null)} />
            </div>
          ) : (
            <input type="file" accept="application/pdf" onChange={(e) => onPickCoa(e.target.files?.[0] ?? null)} />
          )}
        </Field>
      </div>
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Receiving (Pre-Rolls)",
})

export default PreRollReceivingPage

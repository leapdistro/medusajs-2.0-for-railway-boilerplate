import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
  toast,
} from "@medusajs/ui"
import { useEffect, useMemo, useState } from "react"

/* Tier dropdown was removed on 2026-04-25 — tier now derives from the
 * product's sub-category assignment. Operators set tier by picking the
 * Classic / Exotic / Super / Rapper / Snowcaps sub-cat in the Organize
 * section of the product create flow. No separate tier dropdown here. */

const STRAIN_OPTS = [
  { value: "Indica",  label: "Indica" },
  { value: "Sativa",  label: "Sativa" },
  { value: "Hybrid",  label: "Hybrid" },
]

const BEST_FOR_OPTS = [
  { value: "day",     label: "Day" },
  { value: "evening", label: "Evening" },
  { value: "night",   label: "Night" },
]

const POTENCY_OPTS = [
  { value: "1", label: "Low ●○○" },
  { value: "2", label: "Med ●●○" },
  { value: "3", label: "High ●●●" },
]

const ALL_EFFECTS = [
  "Chill", "Energy", "Relief", "Sleep", "Focus",
  "Grounded", "Creative", "Social", "Calm",
] as const

type Form = {
  strain_type: string
  best_for: string
  potency: string
  thca_percent: string
  total_cannabinoids_percent: string
  effects: string[]
  coa_url: string
}

const EMPTY_FORM: Form = {
  strain_type: "",
  best_for: "",
  potency: "",
  thca_percent: "",
  total_cannabinoids_percent: "",
  effects: [],
  coa_url: "",
}

const ProductMbsAttributesWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const productId = data.id
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/admin/products/${productId}/mbs-attributes`, { credentials: "include" })
      .then((r) => r.json())
      .then(({ attributes }) => {
        if (cancelled || !attributes) return
        setForm({
          strain_type: attributes.strain_type ?? "",
          best_for: attributes.best_for ?? "",
          potency: attributes.potency != null ? String(attributes.potency) : "",
          thca_percent: attributes.thca_percent != null ? String(attributes.thca_percent) : "",
          total_cannabinoids_percent:
            attributes.total_cannabinoids_percent != null
              ? String(attributes.total_cannabinoids_percent)
              : "",
          effects: Array.isArray(attributes.effects) ? attributes.effects : [],
          coa_url: attributes.coa_url ?? "",
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [productId])

  const toggleEffect = (effect: string) => {
    setForm((f) => {
      if (f.effects.includes(effect)) {
        return { ...f, effects: f.effects.filter((e) => e !== effect) }
      }
      if (f.effects.length >= 2) {
        toast.warning("Maximum 2 effects per product")
        return f
      }
      return { ...f, effects: [...f.effects, effect] }
    })
  }

  const onSave = async () => {
    setSaving(true)
    try {
      const payload = {
        strain_type: form.strain_type || null,
        best_for: form.best_for || null,
        potency: form.potency ? Number(form.potency) : null,
        thca_percent: form.thca_percent || null,
        total_cannabinoids_percent: form.total_cannabinoids_percent || null,
        effects: form.effects.length ? form.effects : null,
        coa_url: form.coa_url || null,
      }
      const res = await fetch(`/admin/products/${productId}/mbs-attributes`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      toast.success("MBS attributes saved")
    } catch (e: any) {
      toast.error(e?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const effectsCount = form.effects.length

  const SelectField = ({
    label,
    value,
    onChange,
    options,
    placeholder,
  }: {
    label: string
    value: string
    onChange: (v: string) => void
    options: { value: string; label: string }[]
    placeholder: string
  }) => (
    <div className="flex flex-col gap-y-2">
      <Label size="small" weight="plus">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <Select.Trigger><Select.Value placeholder={placeholder} /></Select.Trigger>
        <Select.Content>
          {options.map((o) => (
            <Select.Item key={o.value} value={o.value}>{o.label}</Select.Item>
          ))}
        </Select.Content>
      </Select>
    </div>
  )

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">MBS Attributes</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Cannabis-specific fields used by the storefront (strain, potency, COA, effects). Tier comes from the sub-category in Organize.
          </Text>
        </div>
        <Button variant="primary" onClick={onSave} isLoading={saving} disabled={loading}>
          Save attributes
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 px-6 py-6 md:grid-cols-2">
        <SelectField
          label="Strain Type"
          value={form.strain_type}
          onChange={(v) => setForm({ ...form, strain_type: v })}
          options={STRAIN_OPTS}
          placeholder="Indica / Sativa / Hybrid"
        />
        <SelectField
          label="Best For"
          value={form.best_for}
          onChange={(v) => setForm({ ...form, best_for: v })}
          options={BEST_FOR_OPTS}
          placeholder="Day / Evening / Night"
        />
        <SelectField
          label="Potency"
          value={form.potency}
          onChange={(v) => setForm({ ...form, potency: v })}
          options={POTENCY_OPTS}
          placeholder="1 / 2 / 3"
        />
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">COA</Label>
          <CoaField
            value={form.coa_url}
            onChange={(url) => setForm({ ...form, coa_url: url })}
          />
        </div>
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">THCa %</Label>
          <Input
            type="number"
            step="0.1"
            value={form.thca_percent}
            onChange={(e) => setForm({ ...form, thca_percent: e.target.value })}
            placeholder="26.4"
          />
        </div>
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">Total Cannabinoids %</Label>
          <Input
            type="number"
            step="0.1"
            value={form.total_cannabinoids_percent}
            onChange={(e) => setForm({ ...form, total_cannabinoids_percent: e.target.value })}
            placeholder="24.3"
          />
        </div>
      </div>

      <div className="flex flex-col gap-y-3 px-6 py-6">
        <div className="flex items-center justify-between">
          <Label size="small" weight="plus">Effects (pick up to 2)</Label>
          <Text size="small" className="text-ui-fg-subtle">{effectsCount}/2 selected</Text>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_EFFECTS.map((eff) => {
            const selected = form.effects.includes(eff)
            return (
              <button
                key={eff}
                type="button"
                onClick={() => toggleEffect(eff)}
                className="focus:outline-none"
              >
                <Badge
                  size="small"
                  color={selected ? "green" : "grey"}
                  className="cursor-pointer"
                >
                  {eff}
                </Badge>
              </button>
            )
          })}
        </div>
      </div>
    </Container>
  )
}

/* ────────────────────────────────────────────────────────────────────
 * CoaField — drag-and-drop COA upload + URL state.
 *
 * Three modes the operator sees:
 *   1. EMPTY: dropzone says "Drop COA PDF here, or paste a URL below"
 *   2. UPLOADED: shows ✓ filename + open-in-new-tab link + replace/remove
 *   3. PASTED URL (legacy): shows the URL as text + clear-to-upload-fresh
 *
 * Posts to /admin/receiving/coa-upload (the same endpoint the receiving
 * page uses for bulk COA uploads) — single file, gets back the
 * publicly-reachable URL (MinIO in prod, /static in dev).
 *
 * Failures don't dirty the field — operator can retry without losing
 * what's already saved.
 * ──────────────────────────────────────────────────────────────────── */
const CoaField: React.FC<{
  value: string
  onChange: (url: string) => void
}> = ({ value, onChange }) => {
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useState<HTMLInputElement | null>(null)
  const [inputEl, setInputEl] = inputRef

  const upload = async (file: File) => {
    setError(null)
    if (file.type !== "application/pdf" && !file.type.startsWith("image/")) {
      setError(`Unsupported type: ${file.type}. PDF or image only.`)
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 10 MB`)
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append("coas", file)
      const res = await fetch("/admin/receiving/coa-upload", {
        method: "POST",
        credentials: "include",
        body: fd,
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.error ?? `Upload failed (${res.status})`)
      const uploaded = json.files?.[0]
      if (!uploaded?.url) throw new Error("Upload succeeded but no URL returned")
      onChange(uploaded.url)
      toast.success("COA uploaded", {
        description: `${uploaded.originalName} → file storage. Click Save to persist.`,
      })
    } catch (e: any) {
      setError(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  const fileNameFromUrl = (url: string): string => {
    try {
      const path = new URL(url).pathname
      return decodeURIComponent(path.split("/").pop() ?? url)
    } catch {
      return url.split("/").pop() ?? url
    }
  }

  return (
    <div className="flex flex-col gap-y-2">
      {/* Current value display — only when set */}
      {value && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(84,148,2,0.06)", border: "1px solid #549402", fontFamily: "monospace", fontSize: 12 }}>
          <span style={{ color: "#549402" }}>✓</span>
          <a href={value} target="_blank" rel="noopener noreferrer"
             style={{ color: "#0A0A0A", textDecoration: "underline", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
             title={value}>
            {fileNameFromUrl(value)}
          </a>
          <button type="button" onClick={() => onChange("")}
                  style={{ background: "transparent", border: "none", color: "#B91C1C", cursor: "pointer", fontSize: 14, padding: 0 }}
                  title="Remove">×</button>
        </div>
      )}

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) upload(f)
        }}
        onClick={() => inputEl?.click()}
        style={{
          border: dragOver ? "2px solid #0A0A0A" : "1.5px dashed #C9C3B2",
          background: dragOver ? "rgba(10,10,10,0.04)" : "#FAFAF7",
          padding: "16px 12px",
          textAlign: "center",
          cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.6 : 1,
          transition: "all 120ms ease",
          fontSize: 12,
          fontFamily: "monospace",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
        }}
      >
        <input
          ref={(el) => setInputEl(el)}
          type="file"
          accept="application/pdf,image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) upload(f)
            if (e.target) e.target.value = ""
          }}
        />
        {busy
          ? "Uploading…"
          : value
            ? "Drop a new file to replace"
            : "Drop COA PDF here, or click to browse"}
      </div>

      {/* Manual URL fallback (collapsed unless operator wants it) */}
      <details style={{ fontSize: 11 }}>
        <summary style={{ cursor: "pointer", color: "#4A4A45", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Paste URL instead
        </summary>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… or /coas/strain.pdf"
          className="mt-2"
        />
      </details>

      {error && (
        <div style={{ border: "1px solid #B91C1C", padding: "6px 10px", background: "#fff", fontSize: 12 }}>
          <Text size="small" weight="plus" style={{ color: "#B91C1C" }}>{error}</Text>
        </div>
      )}
    </div>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default ProductMbsAttributesWidget

import { Button, Label, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { ColResizeHandle } from "../lib/resizable-columns"

/* Pieces shared by the receiving pages: COA upload and reader button,
 * save-result pill, draft card, and the spreadsheet atoms. Moved out of
 * routes/receiving/page.tsx unchanged so the all-categories page uses
 * the same ones. */

/* Serializable COA state — replaces the old File-object approach.
 * Files upload immediately on pick (per-row or bulk drop), so by
 * the time we save a draft or finalize, every row's coa is already
 * a URL on MinIO/local storage. State machine handles error/retry. */
export type CoaState =
  | { state: "idle" }
  | { state: "uploading"; originalName: string }
  | { state: "ready"; url: string; originalName: string; mimeType: string }
  | { state: "error"; originalName: string; error: string }

/* Mirrors the server-side SaveRowResult — only the fields the UI
 * renders, plus an optional error string. */
export type SaveRowResult = {
  strainName: string
  action: "created" | "restocked" | "failed" | "already-saved" | "not-saved"
  productId?: string
  productHandle?: string
  qtyQps: number
  error?: string
}

/* Persisted draft summary — what shows in the resume cards. Cheap to
 * keep in sync (rewritten on every save). */
export type DraftSummary = {
  fileName: string
  supplierName: string
  invoiceNumber: string
  lineItemCount: number
  completeRows: number
}

export type DraftRow = {
  id: string
  payload: any
  summary: DraftSummary
  created_at: string
  updated_at: string
}

/* ---------- Save-result pill ---------- */
export const SaveStatusPill: React.FC<{ result: SaveRowResult }> = ({ result }) => {
  if (result.action === "failed") {
    return (
      <div style={{ marginTop: 4 }}>
        <span
          style={{ display: "inline-block", padding: "1px 6px", border: "1px solid #B91C1C", color: "#B91C1C", fontFamily: "monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          ✗ failed
        </span>
        {result.error && (
          <div
            style={{
              marginTop: 4,
              padding: "4px 6px",
              background: "rgba(185,28,28,0.06)",
              border: "1px solid #B91C1C",
              color: "#7F1D1D",
              fontFamily: "monospace",
              fontSize: 10,
              lineHeight: 1.4,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
            title="Per-row error from the save handler — names the failing step + relevant ids so you can fix it directly."
          >
            {result.error}
          </div>
        )}
      </div>
    )
  }
  if (result.action === "not-saved" || result.action === "already-saved") {
    const notSaved = result.action === "not-saved"
    return (
      <span title={notSaved ? "Nothing was saved because another row failed the check." : "Saved earlier on this invoice. Skipped so its stock isn't added twice."}
        style={{ display: "inline-block", marginTop: 4, padding: "1px 6px", border: "1px solid #4A4A45", color: "#4A4A45", fontFamily: "monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {notSaved ? "not saved yet" : "✓ already saved"}
      </span>
    )
  }
  const label = result.action === "created" ? "✓ created" : "✓ restocked"
  return (
    <span title={`${result.qtyQps} QPs added · ${result.productHandle ?? ""}`}
      style={{ display: "inline-block", marginTop: 4, padding: "1px 6px", border: "1px solid #549402", color: "#549402", fontFamily: "monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      {label}
    </span>
  )
}

/* ---------- Per-row AI extract trigger ----------
 * Tiny button that lives in the THCa cell. Disabled when there's no
 * COA to parse, shows a spinner glyph while parsing. Title hover tells
 * the operator what it does + the cost. */
export const CoaAiButton: React.FC<{
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
export async function uploadCoas(files: File[]): Promise<{
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
export const CoaUpload: React.FC<{
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
export const BulkCoaDropzone: React.FC<{
  rows: Array<{ strainName: string; coa: CoaState }>
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

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/* ---------- Draft resume card ---------- */
export const DraftCard: React.FC<{
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

export function formatRelativeTime(d: Date): string {
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
export const CheckBox: React.FC<{
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
export const BulkSelect: React.FC<{
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
export const Th: React.FC<{
  children: React.ReactNode
  align?: "left" | "right"
  /** When provided, renders a drag handle on the right edge of this
   *  <th>; pointer down starts a column resize. Wire via the
   *  useColumnWidths() hook's startResize(index). */
  onResize?: (e: React.PointerEvent<HTMLDivElement>) => void
}> = ({ children, align = "left", onResize }) => (
  <th style={{
    position: "relative",
    padding: "10px 8px",
    textAlign: align,
    fontFamily: "monospace",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }}>
    {children}
    {onResize && <ColResizeHandle onResize={onResize} />}
  </th>
)
export const Td: React.FC<{ children: React.ReactNode; align?: "left" | "right"; style?: React.CSSProperties }> = ({ children, align = "left", style }) => (
  <td style={{ padding: "8px", textAlign: align, verticalAlign: "middle", ...style }}>{children}</td>
)
export const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <Label size="xsmall" weight="plus">{label}</Label>
    {children}
  </div>
)

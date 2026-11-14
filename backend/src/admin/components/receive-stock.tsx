import { Badge, Button, Heading, Input, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DraftCard, type DraftRow } from "./receiving-parts"
import { VendorPicker, supplierReady, useQboVendors, type SupplierFields } from "./vendor-picker"

/**
 * Receive stock (owner, 2026-11-14, modelled on Lightspeed X-Series):
 * the Receiving page for resold brands (categories with the Brand field
 * on). Pick the supplier, drop in the invoice, check the lines, receive.
 *
 * - A product already in the catalog is one line: boxes and cost. Sell
 *   (box and case price) shows the current price; the margin on landed
 *   cost is worked out as you type. Prices change only when you change them.
 * - A product not in the catalog opens an "Add to the catalog" panel:
 *   name, brand, sub-category, description, box count, optional case,
 *   up to three options (Flavour, Colour…) with one line per value, each
 *   with its UPC, boxes, cost, prices and photos. Done folds it into one
 *   line like the others.
 * - Matching: UPC first, then the name. A new product whose name looks
 *   like a catalog product asks before creating a duplicate.
 * - Scan a box's barcode (a USB scanner types into the search box, or the
 *   camera where the browser can read barcodes) to count it.
 * - Receive first shows what changes: costs, prices and margins.
 *
 * Saves through /admin/receiving/stock/save (lib/stock-receive.ts).
 */

/* ---------- Catalog (GET /admin/receiving/stock/catalog) ---------- */
type CatalogItem = {
  inventoryItemId: string
  productId: string
  productTitle: string
  brand: string | null
  categoryId: string | null
  status: string
  values: Record<string, string>
  upc: string | null
  thumbnail: string | null
  box: { variantId: string; price: number | null; label: string } | null
  case: { variantId: string; price: number | null; perCase: number } | null
  piecesPerBox: number | null
  pieceName: string | null
  landed: number | null
  stock: number
  history: Array<{ date: string; supplier: string | null; invoice: string | null; cost: number | null; landed: number; boxPrice: number | null; qty: number }>
}
type Catalog = {
  profile: {
    key: string
    displayName: string
    invoiceUpload: boolean
    subcategories: Array<{ id: string; name: string; label: string }>
    ownerMarkupKey: string | null
    ownerMarkup: number | null
  }
  brands: string[]
  items: CatalogItem[]
  products: Array<{ id: string; title: string; brand: string | null; options: Array<{ title: string; values: string[] }> }>
}

/* ---------- Invoice (lib/ai-stock-invoice.ts) ---------- */
type InvoiceLine = {
  description: string
  productName: string
  brand: string | null
  upc: string | null
  optionName: string | null
  optionValue: string | null
  quantityBoxes: number
  costPerBox: number
  piecesPerBox: number | null
  pieceName: string | null
  boxesPerCase: number | null
}

/* ---------- Lines ---------- */
type Photo = { key: string; preview?: string; url?: string; status: "uploading" | "saved" | "failed"; blob?: Blob }
type RestockLine = {
  id: string
  kind: "restock"
  inventoryItemId: string
  qty: string
  cost: string
  boxPrice: string
  casePrice: string
  /** Fields filled from the invoice (yellow). */
  read: string[]
  showHistory?: boolean
}
type NewItem = {
  id: string
  values: Record<string, string>
  upc: string
  qty: string
  cost: string
  boxPrice: string
  casePrice: string
  photos: Photo[]
  read: string[]
}
type NewLine = {
  id: string
  kind: "new"
  open: boolean
  title: string
  brand: string
  categoryId: string
  description: string
  unitCount: string
  unitName: string
  caseOn: boolean
  perCase: string
  options: string[]
  items: NewItem[]
  /** Photos for every item (box shot). */
  photos: Photo[]
  /** "It's a different product": the look-alike warning was answered. */
  notDuplicate: boolean
  read: string[]
}
type Line = RestockLine | NewLine

type Header = {
  supplier: SupplierFields
  invoiceNumber: string
  invoiceDate: string
  freight: string
  total: string
  fileName: string | null
  notes: string | null
  freeStock: boolean
}

const MAX_OPTIONS = 3
let seq = 0
const uid = (p = "l") => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`
const num = (s: string | number | null | undefined) => {
  const n = typeof s === "number" ? s : Number(String(s ?? "").replace(/[$,\s]/g, ""))
  return Number.isFinite(n) ? n : 0
}
const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`)
const str = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n === 0 ? "" : String(Math.round(n * 100) / 100))
/** Dollars for an input: "18.50". */
const cents = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n === 0 ? "" : n.toFixed(2))
const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "")
const itemLabel = (it: { productTitle: string; values: Record<string, string> }) =>
  [it.productTitle, ...Object.values(it.values)].join(" · ")
const pct = (sell: number, landed: number) => (sell > 0 ? ((sell - landed) / sell) * 100 : null)

/* Words two names share, over the words of the shorter one: "RAW Classic
 * 1¼ Papers" vs "Raw Classic 1 1/4 Rolling Papers" is a near match. */
function similarity(a: string, b: string): number {
  const wa = new Set(norm(a).split(" ").filter(Boolean))
  const wb = new Set(norm(b).split(" ").filter(Boolean))
  if (!wa.size || !wb.size) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared += 1
  return shared / Math.min(wa.size, wb.size)
}

const blankHeader = (): Header => ({
  supplier: { name: "", phone: null, email: null, address: null },
  invoiceNumber: "",
  invoiceDate: new Date().toISOString().slice(0, 10),
  freight: "",
  total: "",
  fileName: null,
  notes: null,
  freeStock: false,
})

const restockLine = (it: CatalogItem, qty = "", cost = "", read: string[] = []): RestockLine => ({
  id: uid(),
  kind: "restock",
  inventoryItemId: it.inventoryItemId,
  qty,
  cost,
  boxPrice: cents(it.box?.price),
  casePrice: cents(it.case?.price),
  read,
})

const newItem = (values: Record<string, string> = {}): NewItem => ({
  id: uid("i"), values, upc: "", qty: "", cost: "", boxPrice: "", casePrice: "", photos: [], read: [],
})

const newLine = (partial: Partial<NewLine> = {}): NewLine => ({
  id: uid(),
  kind: "new",
  open: true,
  title: "",
  brand: "",
  categoryId: "",
  description: "",
  unitCount: "",
  unitName: "",
  caseOn: false,
  perCase: "",
  options: [],
  items: [newItem()],
  photos: [],
  notDuplicate: false,
  read: [],
  ...partial,
})

/* ---------- Photo upload (same path as Product Photos) ---------- */
async function shrink(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions)
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height))
    if (scale === 1 && blob.type === "image/jpeg") return blob
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return (await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9))) ?? blob
  } catch {
    return blob
  }
}
async function uploadPhoto(blob: Blob, name: string): Promise<string> {
  const fd = new FormData()
  fd.append("files", await shrink(blob), `${norm(name).replace(/ /g, "-") || "product"}-${Date.now()}.jpg`)
  const res = await fetch("/admin/uploads", { method: "POST", credentials: "include", body: fd })
  const json = await res.json().catch(() => ({}))
  const url = json?.files?.[0]?.url
  if (!res.ok || !url) throw new Error(json?.message ?? `Upload failed (${res.status})`)
  return url
}

/* ---------- Invoice lines → screen lines ---------- */
function linesFromInvoice(lines: InvoiceLine[], catalog: Catalog): Line[] {
  const out: Line[] = []
  const byUpc = new Map(catalog.items.filter((i) => digits(i.upc)).map((i) => [digits(i.upc), i]))
  const byName = new Map(catalog.items.map((i) => [norm(itemLabel(i).replace(/·/g, " ")), i]))
  const groups = new Map<string, NewLine>()
  for (const l of lines) {
    const qty = str(l.quantityBoxes)
    const cost = cents(l.costPerBox)
    const name = [l.productName, l.optionValue].filter(Boolean).join(" ")
    const match = (digits(l.upc) && byUpc.get(digits(l.upc))) || byName.get(norm(name)) || byName.get(norm(l.description))
    if (match) {
      const existing = out.find((x) => x.kind === "restock" && x.inventoryItemId === match.inventoryItemId) as RestockLine | undefined
      if (existing) existing.qty = str(num(existing.qty) + num(qty))
      else out.push(restockLine(match, qty, cost, ["qty", "cost"]))
      continue
    }
    const key = `${norm(l.brand)}|${norm(l.productName)}`
    let group = groups.get(key)
    if (!group) {
      const brandKnown = catalog.brands.find((b) => norm(b) === norm(l.brand))
      group = newLine({
        title: l.productName || l.description,
        brand: brandKnown ?? l.brand ?? "",
        unitCount: str(l.piecesPerBox),
        unitName: l.pieceName ?? "",
        caseOn: !!(l.boxesPerCase && l.boxesPerCase > 1),
        perCase: str(l.boxesPerCase),
        options: l.optionName ? [l.optionName] : [],
        items: [],
        open: false,
        read: ["title", "brand", ...(l.piecesPerBox ? ["unitCount"] : []), ...(l.pieceName ? ["unitName"] : []), ...(l.boxesPerCase ? ["perCase"] : [])],
      })
      groups.set(key, group)
      out.push(group)
    }
    if (l.optionName && !group.options.includes(l.optionName) && group.options.length < MAX_OPTIONS) group.options.push(l.optionName)
    const values: Record<string, string> = {}
    if (l.optionName && l.optionValue) values[l.optionName] = l.optionValue
    group.items.push({
      ...newItem(values),
      upc: digits(l.upc),
      qty,
      cost,
      read: ["qty", "cost", ...(l.upc ? ["upc"] : [])],
    })
  }
  /* A one-line "group" with an option keeps it only if it says something. */
  for (const g of groups.values()) {
    if (g.items.length === 1 && g.options.length === 1 && !g.items[0].values[g.options[0]]) g.options = []
  }
  return out
}

/* ---------- Small pieces ---------- */
const read = (on: boolean): React.CSSProperties => (on ? { background: "#FEFCE8", borderColor: "#FDE68A" } : {})
const cellInput = (w = 76): React.CSSProperties => ({ width: w })
const th: React.CSSProperties = { textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--fg-subtle, #52525b)", padding: "8px 8px", borderBottom: "1px solid var(--border-base, #e4e4e7)", whiteSpace: "nowrap", background: "var(--bg-subtle, #fafafa)" }
const td: React.CSSProperties = { padding: "8px", borderBottom: "1px solid var(--border-base, #f1f1f3)", verticalAlign: "top" }
const hint: React.CSSProperties = { fontSize: 11.5, color: "var(--fg-muted, #71717a)", marginTop: 3, whiteSpace: "nowrap" }
const pill = (bg: string, fg: string): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, borderRadius: 999, padding: "2px 9px", background: bg, color: fg, whiteSpace: "nowrap" })
const linkBtn: React.CSSProperties = { display: "block", fontSize: 11.5, color: "var(--fg-interactive, #2563eb)", marginTop: 4, background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }

const Money = ({ value, onChange, isRead, w, placeholder }: { value: string; onChange: (v: string) => void; isRead?: boolean; w?: number; placeholder?: string }) => (
  <Input size="small" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ ...cellInput(w), ...read(!!isRead) }} />
)

const Margin = ({ sell, landed, before }: { sell: number; landed: number; before?: number | null }) => {
  const m = pct(sell, landed)
  if (m == null) return <span style={{ color: "var(--fg-muted, #a1a1aa)" }}>—</span>
  const drop = before != null && m < before - 0.05
  return (
    <div>
      <b style={{ color: m < 0 ? "#B91C1C" : undefined }}>{m.toFixed(1)}%</b>
      {before != null && Math.abs(m - before) >= 0.05 && (
        <div style={{ ...hint, color: drop ? "#B45309" : "#166534" }}>{drop ? "▼" : "▲"} from {before.toFixed(1)}%</div>
      )}
    </div>
  )
}

const Thumbs = ({ photos, onAdd, onRemove, label }: { photos: Photo[]; onAdd: (files: File[]) => void; onRemove: (key: string) => void; label: string }) => {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {photos.map((p) => (
        <span key={p.key} style={{ position: "relative", width: 34, height: 34, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-base, #e4e4e7)", background: "#f4f4f5" }}>
          <img src={p.preview ?? p.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: p.status === "saved" ? 1 : 0.5 }} />
          {p.status === "failed" && <span style={{ position: "absolute", inset: 0, background: "rgba(185,28,28,.55)", color: "#fff", fontSize: 10, display: "grid", placeItems: "center" }}>failed</span>}
          <button type="button" title="Remove" onClick={() => onRemove(p.key)} style={{ position: "absolute", top: 0, right: 0, width: 14, height: 14, fontSize: 10, lineHeight: "12px", background: "rgba(0,0,0,.55)", color: "#fff", border: 0, borderRadius: "0 0 0 4px", cursor: "pointer" }}>×</button>
        </span>
      ))}
      <button type="button" onClick={() => input.current?.click()} title={label}
        style={{ height: 34, minWidth: 34, padding: "0 8px", borderRadius: 6, border: "1px dashed var(--border-strong, #a1a1aa)", background: "transparent", fontSize: 12, cursor: "pointer", color: "var(--fg-subtle, #52525b)" }}>
        {photos.length ? "+" : "+ Photo"}
      </button>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden
        onChange={(e) => { onAdd(Array.from(e.target.files ?? [])); e.target.value = "" }} />
    </div>
  )
}

/* ---------- Camera barcode scanner (browsers with BarcodeDetector) ---------- */
const canScanWithCamera = () => typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia

const CameraScanner = ({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) => {
  const video = useRef<HTMLVideoElement>(null)
  const [msg, setMsg] = useState("Starting camera…")
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 })
  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: any
    let stopped = false
    const Detector = (window as any).BarcodeDetector
    const detector = new Detector({ formats: ["upc_a", "upc_e", "ean_13", "ean_8", "code_128"] })
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      video.current!.srcObject = s
      video.current!.play().catch(() => {})
      setMsg("Point the camera at a box's barcode. Each box counts once.")
      const tick = async () => {
        if (stopped) return
        try {
          const found = await detector.detect(video.current)
          const code = found?.[0]?.rawValue
          const now = Date.now()
          /* The same code again within 2s is the same box still in view. */
          if (code && (code !== last.current.code || now - last.current.at > 2000)) {
            last.current = { code, at: now }
            onCode(code)
          } else if (code) {
            last.current.at = now
          }
        } catch { /* keep trying */ }
        timer = setTimeout(tick, 250)
      }
      tick()
    }).catch(() => setMsg("The camera couldn't be opened. Use a USB scanner or type the barcode."))
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()) }
  }, [])
  return (
    <div className="flex flex-col gap-2" style={{ maxWidth: 420 }}>
      <video ref={video} playsInline muted style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", background: "#000", borderRadius: 8 }} />
      <div className="flex items-center justify-between gap-2">
        <Text size="small" className="text-ui-fg-subtle">{msg}</Text>
        <Button size="small" variant="secondary" onClick={onClose}>Done scanning</Button>
      </div>
    </div>
  )
}

/* =========================================================
 * The screen
 * ========================================================= */
export const ReceiveStock = ({ profileKey }: { profileKey: string }) => {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [header, setHeader] = useState<Header>(blankHeader)
  const [lines, setLines] = useState<Line[]>([])
  const [draftId, setDraftId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [reading, setReading] = useState(false)
  const [review, setReview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [search, setSearch] = useState("")
  const [scanning, setScanning] = useState(false)
  const vendors = useQboVendors()
  const idemKey = useRef<string>(uid("rs"))
  const invoiceInput = useRef<HTMLInputElement>(null)
  const draftKind = `stock:${profileKey}`
  /* The scanner's callback outlives renders; it reads lines from here. */
  const linesRef = useRef<Line[]>(lines)
  linesRef.current = lines

  const loadCatalog = useCallback(() => {
    fetch(`/admin/receiving/stock/catalog?key=${encodeURIComponent(profileKey)}`, { credentials: "include" })
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
        setCatalog(j as Catalog)
      })
      .catch((e) => setLoadError(e?.message ?? "Couldn't load the catalog"))
  }, [profileKey])
  useEffect(loadCatalog, [loadCatalog])
  useEffect(() => {
    fetch(`/admin/receiving/drafts?kind=${encodeURIComponent(draftKind)}`, { credentials: "include" })
      .then((r) => r.json()).then((j) => setDrafts(j?.drafts ?? [])).catch(() => {})
  }, [draftKind])

  const itemsById = useMemo(() => new Map((catalog?.items ?? []).map((i) => [i.inventoryItemId, i])), [catalog])
  const subcats = catalog?.profile.subcategories ?? []

  /* ---- Line edits ---- */
  const patch = (id: string, p: Partial<RestockLine> | Partial<NewLine>) =>
    setLines((ls) => ls.map((l) => (l.id === id ? ({ ...l, ...p } as Line) : l)))
  const patchItem = (lineId: string, itemId: string, p: Partial<NewItem>) =>
    setLines((ls) => ls.map((l) => (l.id === lineId && l.kind === "new"
      ? { ...l, items: l.items.map((it) => (it.id === itemId ? { ...it, ...p } : it)) }
      : l)))
  const remove = (id: string) => setLines((ls) => ls.filter((l) => l.id !== id))

  /* ---- Photos: upload as soon as they're picked ---- */
  const setPhotos = (lineId: string, itemId: string | null, f: (ps: Photo[]) => Photo[]) =>
    setLines((ls) => ls.map((l) => {
      if (l.id !== lineId || l.kind !== "new") return l
      if (!itemId) return { ...l, photos: f(l.photos) }
      return { ...l, items: l.items.map((it) => (it.id === itemId ? { ...it, photos: f(it.photos) } : it)) }
    }))
  const addPhotos = (line: NewLine, itemId: string | null, files: File[]) => {
    const ok = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type))
    if (ok.length < files.length) toast.error("Some files were skipped", { description: "Use JPEG, PNG or WebP photos." })
    for (const file of ok) {
      const photo: Photo = { key: uid("p"), preview: URL.createObjectURL(file), status: "uploading", blob: file }
      setPhotos(line.id, itemId, (ps) => [...ps, photo])
      uploadPhoto(file, line.title)
        .then((url) => setPhotos(line.id, itemId, (ps) => ps.map((p) => (p.key === photo.key ? { ...p, url, status: "saved", blob: undefined } : p))))
        .catch((e) => {
          setPhotos(line.id, itemId, (ps) => ps.map((p) => (p.key === photo.key ? { ...p, status: "failed" } : p)))
          toast.error("Photo didn't upload", { description: e?.message ?? "Network error" })
        })
    }
  }
  const uploading = lines.some((l) => l.kind === "new" && [...l.photos, ...l.items.flatMap((i) => i.photos)].some((p) => p.status === "uploading"))

  /* ---- Adding lines: search, scan ---- */
  const addItem = (it: CatalogItem, qty = "") => {
    setLines((ls) => {
      const at = ls.findIndex((l) => l.kind === "restock" && l.inventoryItemId === it.inventoryItemId)
      if (at >= 0) {
        const l = ls[at] as RestockLine
        return ls.map((x, i) => (i === at ? { ...l, qty: str(num(l.qty) + (num(qty) || 1)) } : x))
      }
      return [...ls, restockLine(it, qty || "1")]
    })
  }
  const onCode = (raw: string) => {
    const code = digits(raw)
    if (!code) return
    /* A new product line already carrying this UPC counts too. */
    const owner = linesRef.current.find((l): l is NewLine => l.kind === "new" && l.items.some((i) => digits(i.upc) === code))
    if (owner) {
      const it = owner.items.find((i) => digits(i.upc) === code)!
      patchItem(owner.id, it.id, { qty: str(num(it.qty) + 1) })
      return
    }
    const match = catalog?.items.find((i) => digits(i.upc) === code)
    if (match) {
      addItem(match)
      toast.success(`+1 ${itemLabel(match)}`)
    } else {
      const line = newLine({ items: [{ ...newItem(), upc: code, qty: "1" }] })
      setLines((ls) => [...ls, line])
      toast.info(`Barcode ${code} isn't in the catalog`, { description: "Fill in the new product below." })
    }
  }
  const matches = useMemo(() => {
    const q = norm(search)
    if (!q || /^\d{6,}$/.test(search.trim())) return []
    return (catalog?.items ?? [])
      .filter((i) => norm(`${itemLabel(i)} ${i.brand ?? ""} ${i.upc ?? ""}`).includes(q))
      .slice(0, 8)
  }, [search, catalog])

  /* ---- Invoice ---- */
  const readInvoice = async (file: File) => {
    if (!catalog) return
    if (file.type !== "application/pdf") { toast.error("The invoice must be a PDF"); return }
    if (lines.length && !confirm("Reading an invoice replaces the lines on screen. Continue?")) return
    setReading(true)
    try {
      const fd = new FormData()
      fd.append("invoice", file)
      const res = await fetch("/admin/receiving/stock/extract", { method: "POST", credentials: "include", body: fd })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      const inv = j.data
      setHeader((h) => ({
        ...h,
        supplier: { ...h.supplier, ...inv.supplier, qboVendorId: null },
        invoiceNumber: inv.invoiceNumber ?? "",
        invoiceDate: inv.invoiceDate ?? h.invoiceDate,
        freight: cents(inv.shippingTotal),
        total: cents(inv.total),
        fileName: j.fileName ?? file.name,
        notes: inv.notes ?? null,
      }))
      const next = linesFromInvoice(inv.lineItems ?? [], catalog)
      setLines(next)
      toast.success(`${(inv.lineItems ?? []).length} lines read`, {
        description: `${next.filter((l) => l.kind === "restock").length} in the catalog, ${next.filter((l) => l.kind === "new").length} new.`,
      })
    } catch (e: any) {
      toast.error("The invoice couldn't be read", { description: e?.message ?? "Network error" })
    } finally {
      setReading(false)
    }
  }

  /* ---- Money ---- */
  const goods = lines.reduce((s, l) => s + (l.kind === "restock"
    ? num(l.qty) * num(l.cost)
    : l.items.reduce((t, i) => t + num(i.qty) * num(i.cost), 0)), 0)
  const freight = num(header.freight)
  const factor = goods > 0 && freight > 0 ? 1 + freight / goods : 1
  const landedOf = (cost: string | number) => num(cost) * factor
  const boxes = lines.reduce((s, l) => s + (l.kind === "restock" ? num(l.qty) : l.items.reduce((t, i) => t + num(i.qty), 0)), 0)
  const computedTotal = goods + freight
  const invoiceTotal = num(header.total)
  const totalsMatch = invoiceTotal > 0 ? Math.abs(invoiceTotal - computedTotal) < 0.01 : null

  /* ---- Look-alikes: a new product whose name is close to one in the catalog ---- */
  const lookAlike = (l: NewLine) => {
    if (l.notDuplicate || !l.title.trim() || !catalog) return null
    let best: { id: string; title: string; score: number } | null = null
    for (const p of catalog.products) {
      const score = similarity(l.title, p.title)
      if (score >= 0.75 && (!best || score > best.score)) best = { id: p.id, title: p.title, score }
    }
    return best
  }
  const useExisting = (l: NewLine, productId: string) => {
    if (!catalog) return
    const its = catalog.items.filter((i) => i.productId === productId)
    const restocks: RestockLine[] = []
    const left: NewItem[] = []
    for (const ni of l.items) {
      const want = norm(Object.values(ni.values).join(" "))
      const hit = (digits(ni.upc) ? its.find((i) => digits(i.upc) === digits(ni.upc)) : undefined)
        ?? its.find((i) => norm(Object.values(i.values).join(" ")) === want)
        ?? (its.length === 1 && l.items.length === 1 ? its[0] : undefined)
      if (hit) restocks.push(restockLine(hit, ni.qty, ni.cost, ni.read))
      else left.push(ni)
    }
    if (left.length) {
      toast.error(`${left.length} line${left.length === 1 ? " doesn't" : "s don't"} match a ${l.options[0]?.toLowerCase() || "version"} of that product`, {
        description: "They stay as a new product. Check the option values, or add them to the product in Medusa admin.",
      })
    }
    setLines((ls) => ls.flatMap((x) => (x.id !== l.id ? [x] : [
      ...restocks,
      ...(left.length ? [{ ...l, items: left, notDuplicate: true }] : []),
    ])))
  }

  /* ---- Checks ---- */
  const problems = useMemo(() => {
    const out: string[] = []
    if (!supplierReady(header.supplier, vendors)) out.push("Pick the supplier.")
    if (!header.invoiceNumber.trim()) out.push("Enter the invoice number.")
    if (!header.invoiceDate) out.push("Enter the invoice date.")
    if (!lines.length) out.push("Add at least one line.")
    for (const l of lines) {
      if (l.kind === "restock") {
        const it = itemsById.get(l.inventoryItemId)
        const name = it ? itemLabel(it) : "A line"
        if (!(num(l.qty) > 0)) out.push(`${name}: enter the boxes received.`)
        if (!header.freeStock && !(num(l.cost) > 0)) out.push(`${name}: enter the cost per box.`)
      } else {
        const name = l.title.trim() || "A new product"
        if (!l.title.trim()) out.push("A new product has no name.")
        if (!l.categoryId) out.push(`${name}: pick the sub-category.`)
        if (!(Number.isInteger(num(l.unitCount)) && num(l.unitCount) > 0)) out.push(`${name}: how many ${l.unitName || "pieces"} are in a box?`)
        if (l.caseOn && !(Number.isInteger(num(l.perCase)) && num(l.perCase) > 1)) out.push(`${name}: how many boxes are in a case?`)
        if (lookAlike(l)) out.push(`${name}: looks like a product already in the catalog. Use it, or say it's different.`)
        for (const t of l.options) if (!t.trim()) out.push(`${name}: an option has no name.`)
        for (const it of l.items) {
          const label = [name, ...l.options.map((t) => it.values[t])].filter(Boolean).join(" · ")
          for (const t of l.options) if (!String(it.values[t] ?? "").trim()) out.push(`${label}: enter the ${t || "option"}.`)
          if (!(num(it.qty) > 0)) out.push(`${label}: enter the boxes received.`)
          if (!header.freeStock && !(num(it.cost) > 0)) out.push(`${label}: enter the cost per box.`)
          if (!(num(it.boxPrice) > 0)) out.push(`${label}: enter the box price.`)
        }
      }
    }
    if (uploading) out.push("Photos are still uploading.")
    return out
  }, [lines, header, vendors, itemsById, uploading, catalog])

  /* ---- Save ---- */
  const payload = () => ({
    profileKey,
    supplier: header.supplier,
    invoiceNumber: header.invoiceNumber.trim(),
    invoiceDate: header.invoiceDate,
    freight: num(header.freight),
    total: num(header.total) || computedTotal,
    freeStock: header.freeStock,
    draftId,
    restocks: lines.filter((l): l is RestockLine => l.kind === "restock").map((l) => {
      const it = itemsById.get(l.inventoryItemId)
      return {
        inventoryItemId: l.inventoryItemId,
        qty: num(l.qty),
        cost: num(l.cost),
        boxPrice: num(l.boxPrice) > 0 && num(l.boxPrice) !== it?.box?.price ? num(l.boxPrice) : null,
        casePrice: num(l.casePrice) > 0 && num(l.casePrice) !== it?.case?.price ? num(l.casePrice) : null,
      }
    }),
    products: lines.filter((l): l is NewLine => l.kind === "new").map((l) => ({
      title: l.title.trim(),
      brand: l.brand.trim() || null,
      categoryId: l.categoryId,
      description: l.description.trim() || null,
      unitCount: num(l.unitCount),
      unitName: l.unitName.trim(),
      perCase: l.caseOn ? num(l.perCase) : null,
      options: l.options.map((t) => ({ title: t.trim(), values: [...new Set(l.items.map((i) => String(i.values[t] ?? "").trim()))] })),
      imageUrls: l.photos.filter((p) => p.url).map((p) => p.url!),
      items: l.items.map((i) => ({
        values: Object.fromEntries(l.options.map((t) => [t.trim(), String(i.values[t] ?? "").trim()])),
        upc: digits(i.upc) || null,
        qty: num(i.qty),
        cost: num(i.cost),
        boxPrice: num(i.boxPrice),
        casePrice: l.caseOn && num(i.casePrice) > 0 ? num(i.casePrice) : null,
        imageUrls: i.photos.filter((p) => p.url).map((p) => p.url!),
      })),
    })),
  })

  const receive = async () => {
    setSaving(true)
    try {
      const res = await fetch("/admin/receiving/stock/save", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey.current },
        body: JSON.stringify(payload()),
      })
      const j = await res.json().catch(() => ({}))
      if (j?.nothingSaved) {
        toast.error("Nothing was received", { description: (j.errors ?? [j.error]).join(" ") })
        setReview(false)
        idemKey.current = uid("rs")
        return
      }
      if (!res.ok && !j?.results) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setResult(j)
      setReview(false)
      if (!j.ok) idemKey.current = uid("rs")
    } catch (e: any) {
      toast.error("Receiving failed", { description: e?.message ?? "Network error" })
      idemKey.current = uid("rs")
    } finally {
      setSaving(false)
    }
  }

  const saveDraft = async () => {
    const strip = (ps: Photo[]) => ps.filter((p) => p.url).map((p) => ({ key: p.key, url: p.url, status: "saved" as const }))
    const body = {
      payload: {
        header,
        lines: lines.map((l) => (l.kind === "new"
          ? { ...l, photos: strip(l.photos), items: l.items.map((i) => ({ ...i, photos: strip(i.photos) })) }
          : l)),
      },
      summary: {
        kind: draftKind,
        supplierName: header.supplier.name,
        invoiceNumber: header.invoiceNumber,
        lineItemCount: lines.length,
        completeRows: lines.length,
        fileName: header.fileName ?? "typed",
      },
    }
    try {
      const res = await fetch(draftId ? `/admin/receiving/drafts/${draftId}` : "/admin/receiving/drafts", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j?.message ?? `HTTP ${res.status}`)
      setDraftId(j.draft?.id ?? draftId)
      toast.success("Draft saved")
    } catch (e: any) {
      toast.error("Draft didn't save", { description: e?.message })
    }
  }
  const resume = async (d: DraftRow) => {
    const j = await fetch(`/admin/receiving/drafts/${d.id}`, { credentials: "include" }).then((r) => r.json()).catch(() => null)
    const p = j?.draft?.payload
    if (!p) { toast.error("Draft couldn't be opened"); return }
    setHeader({ ...blankHeader(), ...p.header })
    setLines(p.lines ?? [])
    setDraftId(d.id)
  }
  const discard = async (d: DraftRow) => {
    if (!confirm("Discard this draft?")) return
    await fetch(`/admin/receiving/drafts/${d.id}`, { method: "DELETE", credentials: "include" }).catch(() => {})
    setDrafts((ds) => ds.filter((x) => x.id !== d.id))
  }

  useEffect(() => {
    if (!lines.length || result) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [lines.length, result])

  if (loadError) return <Text style={{ color: "#B91C1C" }}>Couldn't load {profileKey}: {loadError}. Reload the page.</Text>
  if (!catalog) return <Text className="text-ui-fg-subtle">Loading the catalog…</Text>

  /* ---------- Saved ---------- */
  if (result) {
    const rs: any[] = result.results ?? []
    const productIds = new Set(rs.filter((r) => r.productId).map((r) => r.productId))
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Heading level="h2">{result.ok ? "Received" : "Received with problems"}</Heading>
          <Text className="text-ui-fg-subtle">
            {result.summary.created} new, {result.summary.restocked} restocked
            {result.summary.failed ? `, ${result.summary.failed} failed` : ""}
            {result.summary.alreadySaved ? `, ${result.summary.alreadySaved} already received earlier` : ""}.
            {result.historyError ? ` The receiving history didn't save: ${result.historyError}` : ""}
          </Text>
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead><tr><th style={th}>Product</th><th style={th}>Result</th><th style={th}>Boxes</th><th style={th}>Landed / box</th><th style={th}>Box · case price</th></tr></thead>
          <tbody>
            {rs.map((r, k) => (
              <tr key={k}>
                <td style={td}>{r.productId ? <a href={`/app/products/${r.productId}`} style={{ color: "var(--fg-interactive, #2563eb)" }}>{r.strainName}</a> : r.strainName}</td>
                <td style={td}>
                  {r.action === "created" && <Badge size="2xsmall" color="green">New</Badge>}
                  {r.action === "restocked" && <Badge size="2xsmall" color="blue">Restocked</Badge>}
                  {r.action === "failed" && <Badge size="2xsmall" color="red">Failed</Badge>}
                  {(r.error || r.warning) && <div style={{ ...hint, whiteSpace: "normal", color: r.action === "failed" ? "#B91C1C" : "#B45309" }}>{r.error ?? r.warning}</div>}
                </td>
                <td style={td}>{r.qtyQps}</td>
                <td style={td}>{money(r.landedPerQp)}</td>
                <td style={td}>{money(r.boxPrice)}{r.casePrice ? ` · ${money(r.casePrice)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 flex-wrap">
          {result.historyId && productIds.size > 0 && <Button asChild><a href={`/app/photos?receiving=${result.historyId}`}>Add Photos</a></Button>}
          {result.historyId && <Button asChild variant="secondary"><a href={`/app/receiving/history/${result.historyId}`}>Receiving record</a></Button>}
          {!result.ok && <Button variant="secondary" onClick={() => setResult(null)}>Back to the lines</Button>}
          <Button variant="secondary" onClick={() => { setResult(null); setLines([]); setHeader(blankHeader()); setDraftId(null); idemKey.current = uid("rs"); loadCatalog() }}>Receive another</Button>
        </div>
      </div>
    )
  }

  /* ---------- Review: what changes ---------- */
  const changes = lines.filter((l): l is RestockLine => l.kind === "restock").map((l) => {
    const it = itemsById.get(l.inventoryItemId)!
    const landedNow = landedOf(l.cost)
    const box = num(l.boxPrice)
    return {
      name: itemLabel(it),
      costBefore: it.landed,
      costAfter: landedNow,
      priceBefore: it.box?.price ?? null,
      priceAfter: box,
      caseBefore: it.case?.price ?? null,
      caseAfter: num(l.casePrice) || null,
      marginBefore: it.box?.price && it.landed ? pct(it.box.price, it.landed) : null,
      marginAfter: pct(box, landedNow),
    }
  })
  const costChanged = changes.filter((c) => c.costBefore != null && Math.abs(c.costBefore - c.costAfter) >= 0.005)
  const priceChanged = changes.filter((c) => (c.priceBefore != null && Math.abs(c.priceBefore - c.priceAfter) >= 0.005) || (c.caseBefore != null && c.caseAfter != null && Math.abs(c.caseBefore - c.caseAfter) >= 0.005))
  const newCount = lines.filter((l) => l.kind === "new").length

  /* ---------- Main ---------- */
  return (
    <div className="flex flex-col gap-4">
      {!lines.length && drafts.length > 0 && (
        <div className="flex flex-col gap-2">
          <Text size="small" weight="plus">Drafts</Text>
          {drafts.map((d) => <DraftCard key={d.id} draft={d} onResume={() => resume(d)} onDiscard={() => discard(d)} />)}
        </div>
      )}

      <div style={{ border: "1px solid var(--border-base, #e4e4e7)", borderRadius: 10, background: "var(--bg-base, #fff)" }}>
        <div style={{ padding: "16px 20px 0" }}>
          <Heading level="h2">Receive stock</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Pick the supplier, drop in the invoice, check the lines, receive. Products in the catalog need only boxes and cost. You set the prices; the margin is worked out on landed cost.
          </Text>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, padding: "14px 20px", alignItems: "start" }}>
          <div className="flex flex-col gap-1" style={{ gridColumn: "span 2", minWidth: 0 }}>
            <Text size="xsmall" weight="plus">Supplier</Text>
            <VendorPicker supplier={header.supplier} list={vendors} onChange={(s) => setHeader((h) => ({ ...h, supplier: s }))} />
          </div>
          <div className="flex flex-col gap-1">
            <Text size="xsmall" weight="plus">Invoice</Text>
            <div
              onClick={() => !reading && invoiceInput.current?.click()}
              onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault() }}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readInvoice(f) }}
              style={{
                border: `1.5px dashed ${header.fileName ? "#22c55e" : "var(--border-strong, #a1a1aa)"}`, borderRadius: 8, minHeight: 32,
                display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 10px", fontSize: 12.5, cursor: reading ? "wait" : "pointer",
                background: header.fileName ? "#f0fdf4" : "transparent", color: header.fileName ? "#166534" : undefined, textAlign: "center",
              }}
            >
              {reading ? "Reading the invoice…" : header.fileName ? `✓ ${header.fileName} · drop another to replace` : "Drop the invoice PDF, or click"}
            </div>
            <input ref={invoiceInput} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) readInvoice(f) }} />
          </div>
          <div className="flex flex-col gap-1">
            <Text size="xsmall" weight="plus">Invoice # · date</Text>
            <div className="flex gap-1">
              <Input size="small" placeholder="Invoice #" value={header.invoiceNumber} onChange={(e) => setHeader((h) => ({ ...h, invoiceNumber: e.target.value }))} />
              <Input size="small" type="date" value={header.invoiceDate} onChange={(e) => setHeader((h) => ({ ...h, invoiceDate: e.target.value }))} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Text size="xsmall" weight="plus">Freight · invoice total</Text>
            <div className="flex gap-1">
              <Input size="small" inputMode="decimal" placeholder="Freight" value={header.freight} onChange={(e) => setHeader((h) => ({ ...h, freight: e.target.value }))} />
              <Input size="small" inputMode="decimal" placeholder="Total" value={header.total} onChange={(e) => setHeader((h) => ({ ...h, total: e.target.value }))} />
            </div>
          </div>
        </div>
        {header.notes && (
          <div style={{ margin: "0 20px 12px", padding: "8px 12px", borderRadius: 8, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12.5 }}>
            <b>From the invoice reader:</b> {header.notes}
          </div>
        )}

        {/* Search / scan */}
        <div style={{ position: "relative", padding: "12px 20px", borderTop: "1px solid var(--border-base, #e4e4e7)" }}>
          <div className="flex gap-2 items-center">
            <div style={{ flex: 1 }}>
              <Input
                size="small"
                placeholder="Scan a barcode, or search a product to add a line…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return
                  e.preventDefault()
                  if (/^\d{6,}$/.test(search.trim())) { onCode(search); setSearch("") }
                  else if (matches[0]) { addItem(matches[0]); setSearch("") }
                }}
              />
            </div>
            {canScanWithCamera() && <Button size="small" variant="secondary" onClick={() => setScanning((s) => !s)}>{scanning ? "Stop camera" : "Scan with camera"}</Button>}
            <Button size="small" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>+ New product</Button>
          </div>
          {matches.length > 0 && (
            <div style={{ position: "absolute", left: 20, right: 20, top: "100%", zIndex: 20, background: "var(--bg-base, #fff)", border: "1px solid var(--border-base, #e4e4e7)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.08)", overflow: "hidden" }}>
              {matches.map((m) => (
                <button key={m.inventoryItemId} type="button" onClick={() => { addItem(m); setSearch("") }}
                  className="hover:bg-ui-bg-base-hover"
                  style={{ display: "flex", width: "100%", gap: 10, alignItems: "center", padding: "8px 12px", border: 0, background: "transparent", textAlign: "left", cursor: "pointer" }}>
                  {m.thumbnail ? <img src={m.thumbnail} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4 }} /> : <span style={{ width: 28, height: 28, borderRadius: 4, background: "#f4f4f5" }} />}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <Text size="small" weight="plus">{itemLabel(m)}</Text>
                    <Text size="xsmall" className="text-ui-fg-subtle">{[m.brand, m.box?.label, m.upc && `UPC ${m.upc}`, `${m.stock} in stock`].filter(Boolean).join(" · ")}</Text>
                  </span>
                </button>
              ))}
            </div>
          )}
          {scanning && <div style={{ marginTop: 10 }}><CameraScanner onCode={onCode} onClose={() => setScanning(false)} /></div>}
        </div>

        {/* Lines */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ ...th, width: "30%" }}>Product</th>
                <th style={th}>Status</th>
                <th style={th}>Boxes</th>
                <th style={th}>Cost / box</th>
                <th style={th}>Landed</th>
                <th style={th}>Box price</th>
                <th style={th}>Case price</th>
                <th style={th}>Margin</th>
                <th style={{ ...th, textAlign: "right" }}>Line</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={10} style={{ ...td, textAlign: "center", padding: 28, color: "var(--fg-muted, #71717a)" }}>
                  No lines yet. Drop the invoice above, scan a box, or search the catalog.
                </td></tr>
              )}
              {lines.map((l) => l.kind === "restock"
                ? <RestockRow key={l.id} line={l} item={itemsById.get(l.inventoryItemId)} landed={landedOf(l.cost)} onPatch={(p) => patch(l.id, p)} onRemove={() => remove(l.id)} />
                : <NewRows key={l.id} line={l} catalog={catalog} factor={factor} subcats={subcats}
                    lookAlike={lookAlike(l)}
                    onPatch={(p) => patch(l.id, p)} onPatchItem={(itemId, p) => patchItem(l.id, itemId, p)}
                    onRemove={() => remove(l.id)}
                    onUseExisting={(pid) => useExisting(l, pid)}
                    onAddPhotos={(itemId, files) => addPhotos(l, itemId, files)}
                    onRemovePhoto={(itemId, key) => setPhotos(l.id, itemId, (ps) => ps.filter((p) => p.key !== key))}
                  />)}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "14px 20px", flexWrap: "wrap", borderTop: "1px solid var(--border-base, #e4e4e7)" }}>
          <div style={{ fontSize: 13 }}>
            {lines.length} line{lines.length === 1 ? "" : "s"} · {boxes} boxes · goods <b>{money(goods)}</b> + freight <b>{money(freight)}</b> = <b>{money(computedTotal)}</b>
            {totalsMatch === true && <span style={{ color: "#166534" }}> · matches the invoice ✓</span>}
            {totalsMatch === false && <span style={{ color: "#B45309" }}> · invoice says {money(invoiceTotal)}</span>}
            {freight > 0 && " · freight split by value"}
            <label style={{ marginLeft: 12, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={header.freeStock} onChange={(e) => setHeader((h) => ({ ...h, freeStock: e.target.checked }))} /> This is free stock
            </label>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={saveDraft} disabled={!lines.length}>Save draft</Button>
            <Button onClick={() => setReview(true)} disabled={!lines.length}>Receive {lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : ""}</Button>
          </div>
        </div>

        {review && (
          <div style={{ margin: "0 20px 20px", padding: 16, borderRadius: 10, border: "1.5px solid var(--fg-base, #18181b)" }} className="flex flex-col gap-3">
            {problems.length > 0 ? (
              <>
                <Heading level="h3">Before receiving</Heading>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{problems.slice(0, 12).map((p, k) => <li key={k}>{p}</li>)}</ul>
                {problems.length > 12 && <Text size="small">…and {problems.length - 12} more.</Text>}
                <div><Button variant="secondary" onClick={() => setReview(false)}>Back to the lines</Button></div>
              </>
            ) : (
              <>
                <Heading level="h3">What changes</Heading>
                <Text size="small">
                  {boxes} boxes into stock{newCount ? `, ${newCount} new product${newCount === 1 ? "" : "s"} in the catalog` : ""}, and a QuickBooks bill to {header.supplier.name} for {money(num(header.total) || computedTotal)}.
                </Text>
                {costChanged.length > 0 && (
                  <div>
                    <Text size="small" weight="plus">Cost changed</Text>
                    <table style={{ borderCollapse: "collapse", fontSize: 12.5, marginTop: 4 }}>
                      <tbody>
                        {costChanged.map((c, k) => (
                          <tr key={k}>
                            <td style={{ padding: "3px 12px 3px 0" }}>{c.name}</td>
                            <td style={{ padding: "3px 12px 3px 0" }}>landed {money(c.costBefore)} → <b>{money(c.costAfter)}</b></td>
                            <td style={{ padding: "3px 12px 3px 0" }}>
                              {c.priceBefore != null && Math.abs(c.priceBefore - c.priceAfter) >= 0.005
                                ? <>price {money(c.priceBefore)} → <b>{money(c.priceAfter)}</b></>
                                : <>price kept at {money(c.priceAfter)}</>}
                            </td>
                            <td style={{ padding: "3px 0", color: (c.marginAfter ?? 0) < (c.marginBefore ?? 0) ? "#B45309" : "#166534" }}>
                              margin {c.marginBefore != null ? `${c.marginBefore.toFixed(1)}% → ` : ""}{c.marginAfter != null ? `${c.marginAfter.toFixed(1)}%` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {priceChanged.filter((c) => !costChanged.includes(c)).length > 0 && (
                  <div>
                    <Text size="small" weight="plus">Price changed</Text>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                      {priceChanged.filter((c) => !costChanged.includes(c)).map((c, k) => (
                        <li key={k}>{c.name}: {money(c.priceBefore)} → <b>{money(c.priceAfter)}</b>{c.caseAfter && c.caseBefore !== c.caseAfter ? `, case ${money(c.caseBefore)} → ${money(c.caseAfter)}` : ""}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!costChanged.length && !priceChanged.length && changes.length > 0 && <Text size="small" className="text-ui-fg-subtle">No cost or price changes on restocked products.</Text>}
                {catalog.profile.ownerMarkupKey && (
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {catalog.profile.ownerMarkup != null
                      ? `Owner Stores prices update to the new cost + $${catalog.profile.ownerMarkup.toFixed(2)} a box.`
                      : "Owner Stores markup isn't set for this category (MBS Settings → Categories), so Owner Stores pay the box price."}
                  </Text>
                )}
                <div className="flex gap-2">
                  <Button onClick={receive} isLoading={saving}>Receive</Button>
                  <Button variant="secondary" onClick={() => setReview(false)} disabled={saving}>Back to the lines</Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- A product already in the catalog ---------- */
const RestockRow = ({ line, item, landed, onPatch, onRemove }: {
  line: RestockLine
  item: CatalogItem | undefined
  landed: number
  onPatch: (p: Partial<RestockLine>) => void
  onRemove: () => void
}) => {
  if (!item) {
    return (
      <tr><td colSpan={10} style={{ ...td, color: "#B91C1C" }}>
        This product is no longer in the catalog. <button type="button" style={{ ...linkBtn, display: "inline" }} onClick={onRemove}>Remove the line</button>
      </td></tr>
    )
  }
  const cost = num(line.cost)
  const box = num(line.boxPrice)
  const kase = num(line.casePrice)
  const lastCost = item.history.find((h) => h.cost != null)?.cost ?? null
  const marginBefore = item.box?.price && item.landed ? pct(item.box.price, item.landed) : null
  return (
    <>
      <tr>
        <td style={td}>
          <div className="flex gap-2 items-start">
            {item.thumbnail ? <img src={item.thumbnail} alt="" style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6 }} /> : null}
            <div style={{ minWidth: 0 }}>
              <b>{itemLabel(item)}</b>
              <div style={{ ...hint, whiteSpace: "normal" }}>
                {[item.brand, item.box?.label, item.case && `Case of ${item.case.perCase}`, item.upc && `UPC ${item.upc}`, `${item.stock} in stock`].filter(Boolean).join(" · ")}
              </div>
              {item.history.length > 0 && (
                <button type="button" style={linkBtn} onClick={() => onPatch({ showHistory: !line.showHistory })}>
                  {line.showHistory ? "Hide cost history ▴" : "Cost history ▾"}
                </button>
              )}
            </div>
          </div>
        </td>
        <td style={td}><span style={pill("#dcfce7", "#166534")}>✓ In catalog</span></td>
        <td style={td}><Money value={line.qty} onChange={(v) => onPatch({ qty: v })} isRead={line.read.includes("qty")} w={64} /></td>
        <td style={td}>
          <Money value={line.cost} onChange={(v) => onPatch({ cost: v })} isRead={line.read.includes("cost")} />
          {lastCost != null && cost > 0 && (
            Math.abs(lastCost - cost) < 0.005
              ? <div style={hint}>same as last time</div>
              : <div style={{ ...hint, color: cost > lastCost ? "#B45309" : "#166534" }}>was {money(lastCost)}</div>
          )}
        </td>
        <td style={td}>{cost > 0 ? money(landed) : "—"}</td>
        <td style={td}>
          <Money value={line.boxPrice} onChange={(v) => onPatch({ boxPrice: v })} />
          {item.box?.price != null && (
            Math.abs(box - item.box.price) < 0.005
              ? <div style={hint}>current price</div>
              : <div style={hint}>was {money(item.box.price)}</div>
          )}
        </td>
        <td style={td}>
          {item.case ? (
            <>
              <Money value={line.casePrice} onChange={(v) => onPatch({ casePrice: v })} />
              {box > 0 && <div style={hint}>{item.case.perCase} × box = {money(box * item.case.perCase)}</div>}
            </>
          ) : <span style={{ color: "var(--fg-muted, #a1a1aa)" }}>—</span>}
        </td>
        <td style={td}>
          {cost > 0 ? <Margin sell={box} landed={landed} before={marginBefore} /> : "—"}
          {item.case && cost > 0 && kase > 0 && <div style={hint}>case {pct(kase, landed * item.case.perCase)?.toFixed(1)}%</div>}
        </td>
        <td style={{ ...td, textAlign: "right" }}>{money(num(line.qty) * cost)}</td>
        <td style={td}><button type="button" title="Remove line" onClick={onRemove} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--fg-muted, #a1a1aa)", fontSize: 16 }}>×</button></td>
      </tr>
      {line.showHistory && (
        <tr><td colSpan={10} style={{ ...td, paddingTop: 0, background: "var(--bg-subtle, #fafafa)" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, margin: "6px 0" }}>
            <thead><tr>{["Date", "Supplier", "Invoice", "Boxes", "Cost / box", "Landed", "Box price", "Margin"].map((h) => <th key={h} style={{ ...th, background: "transparent", padding: "4px 12px 4px 0" }}>{h}</th>)}</tr></thead>
            <tbody>
              {item.history.map((h, k) => (
                <tr key={k}>
                  <td style={{ padding: "3px 12px 3px 0" }}>{h.date}</td>
                  <td style={{ padding: "3px 12px 3px 0" }}>{h.supplier ?? "—"}</td>
                  <td style={{ padding: "3px 12px 3px 0" }}>{h.invoice ?? "—"}</td>
                  <td style={{ padding: "3px 12px 3px 0" }}>{h.qty}</td>
                  <td style={{ padding: "3px 12px 3px 0" }}>{money(h.cost)}</td>
                  <td style={{ padding: "3px 12px 3px 0" }}>{money(h.landed)}</td>
                  <td style={{ padding: "3px 12px 3px 0" }}>{money(h.boxPrice)}</td>
                  <td style={{ padding: "3px 0" }}>{h.boxPrice && h.landed ? `${pct(h.boxPrice, h.landed)!.toFixed(1)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </td></tr>
      )}
    </>
  )
}

/* ---------- A new product ---------- */
const NewRows = ({ line, catalog, factor, subcats, lookAlike, onPatch, onPatchItem, onRemove, onUseExisting, onAddPhotos, onRemovePhoto }: {
  line: NewLine
  catalog: Catalog
  factor: number
  subcats: Catalog["profile"]["subcategories"]
  lookAlike: { id: string; title: string } | null
  onPatch: (p: Partial<NewLine>) => void
  onPatchItem: (itemId: string, p: Partial<NewItem>) => void
  onRemove: () => void
  onUseExisting: (productId: string) => void
  onAddPhotos: (itemId: string | null, files: File[]) => void
  onRemovePhoto: (itemId: string | null, key: string) => void
}) => {
  const many = line.items.length > 1 || line.options.length > 0
  const first = line.items[0]
  const perCase = line.caseOn ? num(line.perCase) : 0
  const qty = line.items.reduce((s, i) => s + num(i.qty), 0)
  const costs = [...new Set(line.items.map((i) => num(i.cost)))]
  const boxes = [...new Set(line.items.map((i) => num(i.boxPrice)))]
  const lineTotal = line.items.reduce((s, i) => s + num(i.qty) * num(i.cost), 0)
  const optionLabel = line.options.filter(Boolean).join(" / ").toLowerCase() || "option"
  const sub = subcats.find((s) => s.id === line.categoryId)
  const summary = [line.brand, sub?.name, num(line.unitCount) ? `Box of ${num(line.unitCount)}${line.unitName ? ` ${line.unitName}` : ""}` : null, perCase > 1 ? `Case of ${perCase}` : null,
    !many && first?.upc ? `UPC ${first.upc}` : null].filter(Boolean).join(" · ")

  /* Prices typed on the first line fill the lines below until changed there. */
  const setItem = (it: NewItem, p: Partial<NewItem>) => {
    onPatchItem(it.id, p)
    if (it.id !== first.id) return
    for (const other of line.items.slice(1)) {
      const q: Partial<NewItem> = {}
      if (p.boxPrice !== undefined && (other.boxPrice === "" || other.boxPrice === first.boxPrice)) q.boxPrice = p.boxPrice
      if (p.casePrice !== undefined && (other.casePrice === "" || other.casePrice === first.casePrice)) q.casePrice = p.casePrice
      if (p.cost !== undefined && (other.cost === "" || other.cost === first.cost)) q.cost = p.cost
      if (Object.keys(q).length) onPatchItem(other.id, q)
    }
  }
  const setOptions = (options: string[]) => {
    /* Renaming an option keeps each line's value. */
    const renamed = line.items.map((it) => {
      const values: Record<string, string> = {}
      options.forEach((t, k) => { values[t] = it.values[t] ?? it.values[line.options[k]] ?? "" })
      return { ...it, values }
    })
    onPatch({ options, items: renamed })
  }
  const addValueLine = () => {
    const copy = newItem(Object.fromEntries(line.options.map((t) => [t, ""])))
    onPatch({ items: [...line.items, { ...copy, cost: first.cost, boxPrice: first.boxPrice, casePrice: first.casePrice }] })
  }

  return (
    <>
      <tr style={{ background: line.open ? "#FFFDF5" : undefined }}>
        <td style={td}>
          <b>{line.title || "New product"}</b>
          <div style={{ ...hint, whiteSpace: "normal" }}>{summary || "Not in the catalog yet"}{many ? ` · ${line.items.length} ${optionLabel}${line.items.length === 1 ? "" : "s"}` : ""}</div>
        </td>
        <td style={td}>
          <span style={pill("#fef3c7", "#92400e")}>● New{many ? ` · ${line.items.length}` : ""}</span>
          <button type="button" style={linkBtn} onClick={() => onPatch({ open: !line.open })}>{line.open ? "Collapse ▴" : "Edit details ▾"}</button>
        </td>
        {many ? (
          <>
            <td style={td}>{qty}</td>
            <td style={td}>{costs.length === 1 ? money(costs[0]) : "varies"}</td>
            <td style={td}>{costs.length === 1 && costs[0] ? money(costs[0] * factor) : "—"}</td>
            <td style={td}>{boxes.every((b) => !b) ? "—" : boxes.length === 1 ? money(boxes[0]) : "varies"}</td>
            <td style={td}>{perCase > 1 && num(first.boxPrice) ? money(num(first.casePrice) || num(first.boxPrice) * perCase) : "—"}</td>
            <td style={td}>{costs.length === 1 && boxes.length === 1 && costs[0] ? <Margin sell={boxes[0]} landed={costs[0] * factor} /> : "—"}</td>
          </>
        ) : (
          <>
            <td style={td}><Money value={first.qty} onChange={(v) => setItem(first, { qty: v })} isRead={first.read.includes("qty")} w={64} /></td>
            <td style={td}><Money value={first.cost} onChange={(v) => setItem(first, { cost: v })} isRead={first.read.includes("cost")} /></td>
            <td style={td}>{num(first.cost) ? money(num(first.cost) * factor) : "—"}</td>
            <td style={td}><Money value={first.boxPrice} onChange={(v) => setItem(first, { boxPrice: v })} /></td>
            <td style={td}>
              {perCase > 1 ? (
                <>
                  <Money value={first.casePrice} placeholder={num(first.boxPrice) ? (num(first.boxPrice) * perCase).toFixed(2) : ""} onChange={(v) => setItem(first, { casePrice: v })} />
                  {num(first.boxPrice) > 0 && <div style={hint}>{perCase} × box = {money(num(first.boxPrice) * perCase)}</div>}
                </>
              ) : <span style={{ color: "var(--fg-muted, #a1a1aa)" }}>—</span>}
            </td>
            <td style={td}>{num(first.cost) ? <Margin sell={num(first.boxPrice)} landed={num(first.cost) * factor} /> : "—"}</td>
          </>
        )}
        <td style={{ ...td, textAlign: "right" }}>{money(lineTotal)}</td>
        <td style={td}><button type="button" title="Remove line" onClick={onRemove} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--fg-muted, #a1a1aa)", fontSize: 16 }}>×</button></td>
      </tr>
      {lookAlike && (
        <tr><td colSpan={10} style={{ ...td, paddingTop: 0, background: "#FFFDF5" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 12px", borderRadius: 8, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 12.5 }}>
            <span>Looks like <b>{lookAlike.title}</b>, already in the catalog.</span>
            <Button size="small" variant="secondary" onClick={() => onUseExisting(lookAlike.id)}>Use that instead</Button>
            <Button size="small" variant="transparent" onClick={() => onPatch({ notDuplicate: true })}>It's a different product</Button>
          </div>
        </td></tr>
      )}
      {line.open && (
        <tr><td colSpan={10} style={{ ...td, paddingTop: 0, background: "#FFFDF5" }}>
          <div style={{ border: "1.5px solid #f59e0b", borderRadius: 10, background: "var(--bg-base, #fff)", padding: "14px 16px" }} className="flex flex-col gap-3">
            <div>
              <Text weight="plus">Add {line.title || "this product"} to the catalog</Text>
              <Text size="xsmall" className="text-ui-fg-subtle">Filled from the invoice where it could be. Collapse it and the line looks like the others; next time it's a plain "In catalog" line.</Text>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
              <div className="flex flex-col gap-1">
                <Text size="xsmall" weight="plus">Product name</Text>
                <Input size="small" value={line.title} onChange={(e) => onPatch({ title: e.target.value, notDuplicate: false })} style={read(line.read.includes("title"))} />
              </div>
              <div className="flex flex-col gap-1">
                <Text size="xsmall" weight="plus">Brand</Text>
                <Input size="small" list="receive-stock-brands" value={line.brand} onChange={(e) => onPatch({ brand: e.target.value })} style={read(line.read.includes("brand"))} />
                {line.brand.trim() && !catalog.brands.some((b) => norm(b) === norm(line.brand)) && <div style={hint}>New brand: it gets a page once saved.</div>}
              </div>
              <div className="flex flex-col gap-1">
                <Text size="xsmall" weight="plus">Sub-category</Text>
                <select value={line.categoryId} onChange={(e) => onPatch({ categoryId: e.target.value })}
                  style={{ height: 32, borderRadius: 6, border: "1px solid var(--border-base, #e4e4e7)", padding: "0 8px", background: "var(--bg-field, #fff)", font: "inherit", fontSize: 13 }}>
                  <option value="">Pick…</option>
                  {subcats.map((s) => <option key={s.id} value={s.id}>{catalog.profile.displayName} › {s.label || s.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Text size="xsmall" weight="plus">Description <span style={{ fontWeight: 400, color: "var(--fg-muted, #a1a1aa)" }}>(optional, shown on the product page)</span></Text>
              <Textarea rows={2} value={line.description} onChange={(e) => onPatch({ description: e.target.value })} placeholder="What it is, what it's made of, what's in the box." />
            </div>

            <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 13 }}>
              <Text size="xsmall" weight="plus">Sold as</Text>
              Box of <Input size="small" inputMode="numeric" value={line.unitCount} onChange={(e) => onPatch({ unitCount: e.target.value })} style={{ width: 64, ...read(line.read.includes("unitCount")) }} />
              <Input size="small" placeholder="booklets" value={line.unitName} onChange={(e) => onPatch({ unitName: e.target.value })} style={{ width: 110, ...read(line.read.includes("unitName")) }} />
              <span style={{ color: "#d4d4d8" }}>|</span>
              <label className="flex items-center gap-1"><input type="checkbox" checked={line.caseOn} onChange={(e) => onPatch({ caseOn: e.target.checked })} /> Also by the case of</label>
              <Input size="small" inputMode="numeric" value={line.perCase} disabled={!line.caseOn} onChange={(e) => onPatch({ perCase: e.target.value })} style={{ width: 64, ...read(line.read.includes("perCase")) }} /> boxes
              <span style={{ color: "#d4d4d8" }}>|</span>
              <span>Photo for every {optionLabel === "option" ? "line" : optionLabel}</span>
              <Thumbs photos={line.photos} label="Add photos" onAdd={(f) => onAddPhotos(null, f)} onRemove={(k) => onRemovePhoto(null, k)} />
            </div>

            <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 13 }}>
              <Text size="xsmall" weight="plus">Options</Text>
              {line.options.length === 0 && <span className="text-ui-fg-subtle">None. Add one if this product comes in flavours, colours or sizes.</span>}
              {line.options.map((t, k) => (
                <span key={k} className="flex items-center gap-1">
                  <Input size="small" value={t} placeholder="Flavour" onChange={(e) => setOptions(line.options.map((x, j) => (j === k ? e.target.value : x)))} style={{ width: 110 }} />
                  <button type="button" title="Remove option" onClick={() => setOptions(line.options.filter((_, j) => j !== k))} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--fg-muted, #a1a1aa)" }}>×</button>
                </span>
              ))}
              {line.options.length < MAX_OPTIONS && (
                <button type="button" style={{ ...linkBtn, display: "inline", marginTop: 0 }} onClick={() => setOptions([...line.options, line.options.length ? "" : "Flavour"])}>
                  + {line.options.length ? "Another option" : "Add an option (Flavour, Colour, Size…)"}
                </button>
              )}
            </div>

            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
              <thead>
                <tr>
                  {line.options.map((t, k) => <th key={k} style={th}>{t || "Option"}</th>)}
                  <th style={th}>UPC</th>
                  {many && <><th style={th}>Boxes</th><th style={th}>Cost / box</th><th style={th}>Landed</th><th style={th}>Box price</th>{perCase > 1 && <th style={th}>Case price</th>}<th style={th}>Margin</th></>}
                  <th style={th}>Photos{many ? ` (this ${optionLabel})` : ""}</th>
                  {many && <th style={{ ...th, textAlign: "right" }}>Line</th>}
                  {line.items.length > 1 && <th style={th} />}
                </tr>
              </thead>
              <tbody>
                {line.items.map((it) => (
                  <tr key={it.id}>
                    {line.options.map((t, k) => (
                      <td key={k} style={td}><Input size="small" value={it.values[t] ?? ""} onChange={(e) => onPatchItem(it.id, { values: { ...it.values, [t]: e.target.value } })} style={{ width: 110 }} /></td>
                    ))}
                    <td style={td}><Input size="small" inputMode="numeric" value={it.upc} onChange={(e) => onPatchItem(it.id, { upc: e.target.value })} style={{ width: 130, ...read(it.read.includes("upc")) }} /></td>
                    {many && (
                      <>
                        <td style={td}><Money value={it.qty} w={60} onChange={(v) => setItem(it, { qty: v })} isRead={it.read.includes("qty")} /></td>
                        <td style={td}><Money value={it.cost} w={68} onChange={(v) => setItem(it, { cost: v })} isRead={it.read.includes("cost")} /></td>
                        <td style={td}>{num(it.cost) ? money(num(it.cost) * factor) : "—"}</td>
                        <td style={td}><Money value={it.boxPrice} w={68} onChange={(v) => setItem(it, { boxPrice: v })} /></td>
                        {perCase > 1 && (
                          <td style={td}>
                            <Money value={it.casePrice} w={76} placeholder={num(it.boxPrice) ? (num(it.boxPrice) * perCase).toFixed(2) : ""} onChange={(v) => setItem(it, { casePrice: v })} />
                          </td>
                        )}
                        <td style={td}>
                          {num(it.cost) && num(it.boxPrice) ? (
                            <>
                              {pct(num(it.boxPrice), num(it.cost) * factor)!.toFixed(1)}%
                              {perCase > 1 && ` · ${pct(num(it.casePrice) || num(it.boxPrice) * perCase, num(it.cost) * factor * perCase)!.toFixed(1)}%`}
                            </>
                          ) : "—"}
                        </td>
                      </>
                    )}
                    <td style={td}><Thumbs photos={it.photos} label="Add photos" onAdd={(f) => onAddPhotos(it.id, f)} onRemove={(k) => onRemovePhoto(it.id, k)} /></td>
                    {many && <td style={{ ...td, textAlign: "right" }}>{money(num(it.qty) * num(it.cost))}</td>}
                    {line.items.length > 1 && (
                      <td style={td}><button type="button" title="Remove" onClick={() => onPatch({ items: line.items.filter((x) => x.id !== it.id) })} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--fg-muted, #a1a1aa)" }}>×</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-start gap-3 flex-wrap">
              {line.options.length > 0 && <Button size="small" variant="secondary" onClick={addValueLine}>+ Another {line.options[0] || "value"}</Button>}
              <div style={{ flex: 1, minWidth: 260, background: "var(--bg-subtle, #f4f4f5)", borderRadius: 8, padding: "9px 12px", fontSize: 12.5 }}>
                On the site: <b>{line.title || "…"}</b>{line.brand ? ` · ${line.brand} colours and brand page` : ""}{sub ? ` · ${catalog.profile.displayName} › ${sub.name}` : ""}
                {line.options.filter(Boolean).map((t) => (
                  <div key={t}>{t}: {[...new Set(line.items.map((i) => i.values[t]).filter(Boolean))].join(" · ") || "…"}</div>
                ))}
                <div>
                  Pack: Box of {num(line.unitCount) || "…"}{num(first.boxPrice) ? ` · ${money(num(first.boxPrice))}` : ""}
                  {perCase > 1 && ` | Case of ${perCase} boxes · ${money(num(first.casePrice) || num(first.boxPrice) * perCase)}`}
                </div>
                {line.description.trim() && <div style={{ color: "var(--fg-muted, #71717a)" }}>The description shows under the name.</div>}
              </div>
              <Button size="small" variant="secondary" onClick={() => onPatch({ open: false })}>Done ▴</Button>
            </div>
          </div>
          <datalist id="receive-stock-brands">{catalog.brands.map((b) => <option key={b} value={b} />)}</datalist>
        </td></tr>
      )}
    </>
  )
}

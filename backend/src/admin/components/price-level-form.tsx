import { Button, Heading, Input, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/**
 * One MBS Settings price tab per price level (Default, Chain of Stores,
 * Low Volume, Distro, Owner Markup). Each table a category names at the
 * level gets a section, built from GET /admin/mbs/price-tables, so a new
 * category shows up here once it names its tables in Categories.
 *
 * A blank cell means "no price": it is left out of the saved table, and
 * the apply skips those variants, so they keep whatever price they have.
 * Saved keys this tab doesn't show (retired sub-categories) are kept.
 */

export type PriceLevelKey = "default" | "tier_2" | "tier_3" | "distro" | "owner"

type CatalogRow = { key: string; label: string; sizes: Array<{ key: string; label: string; multiplier: number }> }
type CatalogTable = {
  key: string
  categories: Array<{ key: string; name: string }>
  rows: CatalogRow[]
  unit?: string
  value: unknown
}
type CatalogLevel = { level: PriceLevelKey; label: string; tables: CatalogTable[] }

const LEVEL_NOTES: Record<PriceLevelKey, string> = {
  default: "The price every approved buyer pays unless their Pricing Mode is Chain of Stores, Low Volume, Distro or Owner Stores. Apply writes each variant's base USD price.",
  tier_2: "Only buyers whose Pricing Mode is Chain of Stores see these prices (customer-group PriceList).",
  tier_3: "Only buyers whose Pricing Mode is Low Volume see these prices (customer-group PriceList).",
  distro: "Only buyers whose Pricing Mode is Distro see these prices (customer-group PriceList).",
  owner: "Owner Stores buyers pay (landed cost + markup) × the size's stock units. Apply recomputes every variant from its latest landed cost.",
}

/* Cell text keyed by `row|size`. "" = no price. */
type Cells = Record<string, string>

const cellKey = (row: string, size: string) => `${row}|${size}`

function cellsFrom(table: CatalogTable): Cells {
  const value = (table.value ?? {}) as Record<string, Record<string, unknown>>
  const cells: Cells = {}
  for (const row of table.rows) {
    for (const size of row.sizes) {
      const n = value?.[row.key]?.[size.key]
      cells[cellKey(row.key, size.key)] = typeof n === "number" && Number.isFinite(n) && n > 0 ? String(n) : ""
    }
  }
  return cells
}

function parsePrice(text: string): number | null | "invalid" {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : "invalid"
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.message ?? `Request failed (${res.status})`)
  return json
}

function applyRequest(level: PriceLevelKey, table: string): { url: string; body: Record<string, unknown> } {
  if (level === "default") return { url: "/admin/mbs/settings/tier-prices/apply", body: { table } }
  if (level === "owner") return { url: "/admin/mbs/settings/owner-prices/apply", body: { table } }
  return { url: "/admin/mbs/settings/group-prices/apply", body: { table, group: level } }
}

export const PriceLevelForm = ({ level }: { level: PriceLevelKey }) => {
  const [data, setData] = useState<CatalogLevel | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch("/admin/mbs/price-tables", { credentials: "include" })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `Load failed (${res.status})`)
      setData(((json.levels ?? []) as CatalogLevel[]).find((l) => l.level === level) ?? null)
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load price tables")
    }
  }, [level])

  useEffect(() => { setData(null); load() }, [load])

  if (error) return <Text size="small" className="text-ui-fg-error">{error}</Text>
  if (!data) return <Text size="small" className="text-ui-fg-subtle">Loading…</Text>

  return (
    <div className="flex flex-col gap-8 max-w-3xl">
      <Text size="small" className="text-ui-fg-subtle">
        {LEVEL_NOTES[level]} Leave a cell blank for no price: those variants keep the price they have.
      </Text>
      {data.tables.length === 0 && (
        <Text size="small" className="text-ui-fg-subtle">
          No category has a {data.label} table. Name one in MBS Settings → Categories.
        </Text>
      )}
      {data.tables.map((t) =>
        level === "owner"
          ? <OwnerSection key={t.key} table={t} onSaved={load} />
          : <GridSection key={t.key} level={level} table={t} onSaved={load} />,
      )}
    </div>
  )
}

const SectionHeader = ({ table }: { table: CatalogTable }) => (
  <div className="flex flex-col">
    <Heading level="h3">{table.categories.map((c) => c.name).join(" · ")}</Heading>
    <Text size="xsmall" className="text-ui-fg-subtle font-mono">{table.key}</Text>
  </div>
)

const ConfirmApply = ({ text, busy, onYes, onNo }: { text: string; busy: boolean; onYes: () => void; onNo: () => void }) => (
  <div className="border border-ui-border-base bg-ui-bg-subtle p-4 flex flex-col gap-3">
    <Text size="small" weight="plus">{text}</Text>
    <Text size="small" className="text-ui-fg-subtle">
      Per-variant price edits made in standard Medusa admin will be overwritten. Variants with a blank cell are skipped.
    </Text>
    <div className="flex items-center gap-2">
      <Button variant="danger" onClick={onYes} isLoading={busy}>Yes, Save &amp; Apply</Button>
      <Button variant="secondary" onClick={onNo} disabled={busy}>Cancel</Button>
    </div>
  </div>
)

const GridSection = ({ level, table, onSaved }: { level: PriceLevelKey; table: CatalogTable; onSaved: () => void }) => {
  const [cells, setCells] = useState<Cells>(() => cellsFrom(table))
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  /* Re-seed only when this table's saved value changes, so saving one
   * section doesn't wipe unsaved edits in another. */
  const savedJson = JSON.stringify(table.value ?? null)
  useEffect(() => { setCells(cellsFrom(table)) }, [savedJson])

  const invalid = Object.entries(cells).filter(([, v]) => parsePrice(v) === "invalid")

  const saveAndApply = async () => {
    setConfirm(false)
    if (invalid.length > 0) { toast.error("Prices must be numbers above 0, or blank."); return }
    setBusy(true)
    try {
      /* Start from the saved table so rows this tab doesn't show survive. */
      const next = JSON.parse(JSON.stringify(table.value ?? {})) as Record<string, Record<string, number>>
      for (const row of table.rows) {
        for (const size of row.sizes) {
          const price = parsePrice(cells[cellKey(row.key, size.key)] ?? "")
          if (typeof price === "number") {
            next[row.key] = { ...(next[row.key] ?? {}), [size.key]: price }
          } else if (next[row.key]) {
            delete next[row.key][size.key]
            if (Object.keys(next[row.key]).length === 0) delete next[row.key]
          }
        }
      }
      await postJson("/admin/mbs/settings", { key: table.key, value: next })
      const { url, body } = applyRequest(level, table.key)
      const j = await postJson(url, body)
      const s = j.summary ?? {}
      toast.success(`Saved & applied · ${(s.added ?? 0) + (s.updated ?? 0)} updated · ${s.skipped ?? 0} skipped`)
      onSaved()
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader table={table} />
      {table.rows.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle">These categories have no sub-categories in Medusa yet.</Text>
      ) : (
        <div className="border divide-y">
          {table.rows.map((row) => (
            <div key={row.key} className="grid grid-cols-[10rem_1fr] gap-3 px-3 py-2 items-center">
              <Text size="small" weight="plus">{row.label}</Text>
              <div className="flex flex-wrap gap-3">
                {row.sizes.map((size) => {
                  const k = cellKey(row.key, size.key)
                  const bad = parsePrice(cells[k] ?? "") === "invalid"
                  return (
                    <label key={size.key} className="flex items-center gap-1.5">
                      <Text size="xsmall" className="text-ui-fg-subtle w-16 text-right">{size.label}</Text>
                      <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
                      <Input
                        size="small"
                        inputMode="decimal"
                        value={cells[k] ?? ""}
                        onChange={(e) => setCells((c) => ({ ...c, [k]: e.target.value }))}
                        aria-invalid={bad}
                        className="w-24 text-right"
                      />
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => setConfirm(true)} isLoading={busy} disabled={table.rows.length === 0}>
          Save &amp; Apply
        </Button>
        {invalid.length > 0 && (
          <Text size="small" className="text-ui-fg-error">{invalid.length} cell(s) aren't a price above 0.</Text>
        )}
      </div>
      {confirm && (
        <ConfirmApply
          text={`Save ${table.key} and reprice every matching variant?`}
          busy={busy}
          onYes={saveAndApply}
          onNo={() => setConfirm(false)}
        />
      )}
    </div>
  )
}

const OwnerSection = ({ table, onSaved }: { table: CatalogTable; onSaved: () => void }) => {
  const initial = typeof table.value === "number" && Number.isFinite(table.value) ? String(table.value) : ""
  const [text, setText] = useState(initial)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setText(initial) }, [initial])

  const trimmed = text.trim()
  const markup = trimmed === "" ? null : Number(trimmed)
  const bad = markup != null && (!Number.isFinite(markup) || markup < 0)

  const saveAndApply = async () => {
    setConfirm(false)
    if (markup == null) { toast.error("Enter a markup first. Blank leaves Owner Stores prices as they are."); return }
    if (bad) { toast.error("Markup must be a number, 0 or more."); return }
    setBusy(true)
    try {
      await postJson("/admin/mbs/settings", { key: table.key, value: markup })
      const j = await postJson("/admin/mbs/settings/owner-prices/apply", { table: table.key })
      const s = j.summary ?? {}
      toast.success(`Saved & applied · ${(s.added ?? 0) + (s.updated ?? 0)} updated · ${s.skipped ?? 0} skipped`)
      onSaved()
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader table={table} />
      <label className="flex items-center gap-2">
        <Text size="small" className="text-ui-fg-subtle">Markup per {table.unit ?? "unit"}</Text>
        <Text size="small" className="text-ui-fg-subtle">$</Text>
        <Input
          size="small"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={bad}
          className="w-28 text-right"
        />
      </label>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => setConfirm(true)} isLoading={busy}>Save &amp; Apply</Button>
        {bad && <Text size="small" className="text-ui-fg-error">Markup must be a number, 0 or more.</Text>}
      </div>
      {confirm && (
        <ConfirmApply
          text={`Save ${table.key} and recompute Owner Stores prices for ${table.categories.map((c) => c.name).join(", ")}?`}
          busy={busy}
          onYes={saveAndApply}
          onNo={() => setConfirm(false)}
        />
      )}
    </div>
  )
}

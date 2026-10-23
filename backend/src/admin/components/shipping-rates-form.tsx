import { Button, Heading, Input, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/**
 * MBS Settings → Shipping Rates. One section per `shipping_rates` bucket
 * a category names (Categories → shippingRatesKey), built from
 * GET /admin/mbs/price-tables. A flat bucket (flower) has one rate per
 * size for every sub-category; the rest are per sub-category.
 *
 * Checkout charges rate × quantity per variant. A blank cell means no
 * rate: it is left out of the setting and those variants keep the rate
 * they have. Save & Apply writes the setting and re-stamps the bucket's
 * variants.
 */

type Row = { key: string; label: string; sizes: Array<{ key: string; label: string }> }
type Bucket = {
  key: string
  categories: Array<{ key: string; name: string }>
  flat: boolean
  rows: Row[]
  value: unknown
}
type Shipping = { value: Record<string, unknown>; buckets: Bucket[] }

const ALL = "*"

/* A flat bucket shows as one row with every size its categories sell. */
function displayRows(b: Bucket): Row[] {
  if (!b.flat) return b.rows
  const sizes: Row["sizes"] = []
  for (const r of b.rows) for (const s of r.sizes) if (!sizes.some((x) => x.key === s.key)) sizes.push(s)
  return [{ key: ALL, label: "Every sub-category", sizes }]
}

const cellKey = (row: string, size: string) => `${row}|${size}`

function cellsFrom(b: Bucket): Record<string, string> {
  const v = (b.value ?? {}) as Record<string, any>
  const cells: Record<string, string> = {}
  for (const row of displayRows(b)) {
    for (const s of row.sizes) {
      const n = row.key === ALL ? v[s.key] : v[row.key]?.[s.key]
      cells[cellKey(row.key, s.key)] = typeof n === "number" && Number.isFinite(n) && n > 0 ? String(n) : ""
    }
  }
  return cells
}

function parseRate(text: string): number | null | "invalid" {
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

export const ShippingRatesForm = () => {
  const [data, setData] = useState<Shipping | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch("/admin/mbs/price-tables", { credentials: "include" })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `Load failed (${res.status})`)
      setData(json.shipping ?? { value: {}, buckets: [] })
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load shipping rates")
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (error) return <Text size="small" className="text-ui-fg-error">{error}</Text>
  if (!data) return <Text size="small" className="text-ui-fg-subtle">Loading…</Text>

  return (
    <div className="flex flex-col gap-8 max-w-3xl">
      <Text size="small" className="text-ui-fg-subtle">
        Flat shipping cost (USD) per variant. Checkout sums rate × quantity across the cart. Receiving stamps these on new
        variants; <strong>Save &amp; Apply</strong> re-stamps existing ones. Leave a cell blank for no rate: those variants
        keep the rate they have, and a variant with no rate at all can't be checked out.
      </Text>
      {data.buckets.length === 0 && (
        <Text size="small" className="text-ui-fg-subtle">No category names a shipping rates bucket. Set one in MBS Settings → Categories.</Text>
      )}
      {data.buckets.map((b) => <BucketSection key={b.key} bucket={b} onSaved={load} />)}
    </div>
  )
}

const BucketSection = ({ bucket, onSaved }: { bucket: Bucket; onSaved: () => void }) => {
  const [cells, setCells] = useState(() => cellsFrom(bucket))
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  /* Re-seed only when this bucket's saved value changes. */
  const savedJson = JSON.stringify(bucket.value ?? null)
  useEffect(() => { setCells(cellsFrom(bucket)) }, [savedJson])

  const rows = displayRows(bucket)
  const invalid = Object.values(cells).filter((v) => parseRate(v) === "invalid").length

  const saveAndApply = async () => {
    setConfirm(false)
    if (invalid > 0) { toast.error("Rates must be numbers above 0, or blank."); return }
    setBusy(true)
    try {
      /* Re-read the whole setting so a save here can't undo another
       * bucket's save from a stale copy. */
      const latest = await fetch("/admin/mbs/price-tables", { credentials: "include" }).then((r) => r.json())
      const all = JSON.parse(JSON.stringify(latest?.shipping?.value ?? {})) as Record<string, any>
      /* Start from the saved bucket so sub-categories this tab doesn't
       * show (retired ones) survive. */
      const next: Record<string, any> = JSON.parse(JSON.stringify(all[bucket.key] ?? {}))
      for (const row of rows) {
        for (const s of row.sizes) {
          const rate = parseRate(cells[cellKey(row.key, s.key)] ?? "")
          if (row.key === ALL) {
            if (typeof rate === "number") next[s.key] = rate
            else delete next[s.key]
            continue
          }
          if (typeof rate === "number") {
            next[row.key] = { ...(next[row.key] ?? {}), [s.key]: rate }
          } else if (next[row.key]) {
            delete next[row.key][s.key]
            if (Object.keys(next[row.key]).length === 0) delete next[row.key]
          }
        }
      }
      all[bucket.key] = next
      await postJson("/admin/mbs/settings", { key: "shipping_rates", value: all })
      const j = await postJson("/admin/mbs/settings/shipping-weights/apply", { bucket: bucket.key })
      const s = j.summary ?? {}
      toast.success(`Saved & applied · ${s.updated ?? 0} variants updated · ${s.skipped ?? 0} skipped`)
      onSaved()
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        <Heading level="h3">{bucket.categories.map((c) => c.name).join(" · ")}</Heading>
        <Text size="xsmall" className="text-ui-fg-subtle font-mono">shipping_rates.{bucket.key}</Text>
      </div>
      {rows.length === 0 || rows.every((r) => r.sizes.length === 0) ? (
        <Text size="small" className="text-ui-fg-subtle">These categories have no sub-categories in Medusa yet.</Text>
      ) : (
        <div className="border divide-y">
          {rows.map((row) => (
            <div key={row.key} className="grid grid-cols-[10rem_1fr] gap-3 px-3 py-2 items-center">
              <Text size="small" weight="plus">{row.label}</Text>
              <div className="flex flex-wrap gap-3">
                {row.sizes.map((s) => {
                  const k = cellKey(row.key, s.key)
                  return (
                    <label key={s.key} className="flex items-center gap-1.5">
                      <Text size="xsmall" className="text-ui-fg-subtle w-16 text-right">{s.label}</Text>
                      <Text size="xsmall" className="text-ui-fg-subtle">$</Text>
                      <Input
                        size="small"
                        inputMode="decimal"
                        value={cells[k] ?? ""}
                        onChange={(e) => setCells((c) => ({ ...c, [k]: e.target.value }))}
                        aria-invalid={parseRate(cells[k] ?? "") === "invalid"}
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
        <Button variant="primary" onClick={() => setConfirm(true)} isLoading={busy}>Save &amp; Apply</Button>
        {invalid > 0 && <Text size="small" className="text-ui-fg-error">{invalid} cell(s) aren't a rate above 0.</Text>}
      </div>
      {confirm && (
        <div className="border border-ui-border-base bg-ui-bg-subtle p-4 flex flex-col gap-3">
          <Text size="small" weight="plus">
            Save these rates and re-stamp every {bucket.categories.map((c) => c.name).join(", ")} variant?
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            Per-variant shipping edits made in standard Medusa admin will be overwritten. Variants with a blank cell are skipped.
          </Text>
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={saveAndApply} isLoading={busy}>Yes, Save &amp; Apply</Button>
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

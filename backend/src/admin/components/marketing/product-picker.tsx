import { Badge, Button, Input, Text } from "@medusajs/ui"
import { useEffect, useMemo, useState } from "react"
import { api, type PickerProduct } from "./api"
import { Modal } from "./modal"

/** Pick products for a products block: search, tick, keep order of ticking. */
export function ProductPicker({ selected, onDone, onClose }: {
  selected: string[]; onDone: (ids: string[]) => void; onClose: () => void
}) {
  const [q, setQ] = useState("")
  const [items, setItems] = useState<PickerProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [picked, setPicked] = useState<string[]>(selected)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      api<{ products: PickerProduct[] }>(`/admin/marketing/products?q=${encodeURIComponent(q)}`)
        .then((r) => { if (!cancelled) setItems(r.products) })
        .catch(() => { if (!cancelled) setItems([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [q])

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const sorted = useMemo(() => items, [items])

  return (
    <Modal
      wide
      title="Add products"
      subtitle="Newest first. Prices in the email are each buyer's own; sold-out products are left out when it sends."
      onClose={onClose}
      footer={<>
        <Text size="small" className="text-ui-fg-subtle mr-auto self-center">{picked.length} selected</Text>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onDone(picked)}>Done</Button>
      </>}
    >
      <Input placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {loading && !sorted.length ? <Text size="small" className="text-ui-fg-subtle">Loading…</Text> : null}
        {!loading && !sorted.length ? <Text size="small" className="text-ui-fg-subtle">No products match.</Text> : null}
        {sorted.map((p) => {
          const on = picked.includes(p.id)
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              className="text-left rounded-md overflow-hidden"
              style={{ border: on ? "2px solid var(--fg-interactive, #3b82f6)" : "1px solid var(--border-base, #e5e7eb)", background: "var(--bg-base, #fff)" }}
            >
              <div style={{ aspectRatio: "1 / 1", background: p.colors.surface, position: "relative" }}>
                {p.image ? <img src={p.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
                {on ? (
                  <span style={{ position: "absolute", top: 6, right: 6, background: "#171B14", color: "#fff", borderRadius: 999, fontSize: 11, padding: "2px 7px" }}>
                    {picked.indexOf(p.id) + 1}
                  </span>
                ) : null}
              </div>
              <div className="p-2">
                <div className="flex items-center gap-1">
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: p.colors.swatch, display: "inline-block" }} />
                  <Text size="xsmall" className="text-ui-fg-subtle truncate">{p.badge || p.category}</Text>
                </div>
                <Text size="small" weight="plus" className="mt-1" style={{ lineHeight: 1.25 }}>{p.title}</Text>
                {!p.inStock ? <Badge size="2xsmall" color="orange" className="mt-1">Sold out</Badge> : null}
              </div>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

/** Small thumbnails list inside the products block, with remove / move. */
export function PickedProducts({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const [info, setInfo] = useState<Record<string, PickerProduct>>({})
  useEffect(() => {
    const missing = ids.filter((id) => !info[id])
    if (!missing.length) return
    api<{ products: PickerProduct[] }>(`/admin/marketing/products?ids=${missing.join(",")}`).then((r) => {
      setInfo((prev) => ({ ...prev, ...Object.fromEntries(r.products.map((p) => [p.id, p])) }))
    }).catch(() => {})
  }, [ids.join(",")])
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= ids.length) return
    const next = [...ids]; [next[i], next[j]] = [next[j], next[i]]; onChange(next)
  }
  if (!ids.length) return <Text size="small" className="text-ui-fg-muted">No products yet.</Text>
  return (
    <div className="flex flex-col gap-1">
      {ids.map((id, i) => {
        const p = info[id]
        return (
          <div key={id} className="flex items-center gap-2 rounded-md border border-ui-border-base px-2 py-1">
            <div style={{ width: 32, height: 32, borderRadius: 4, background: p?.colors.surface ?? "#eee", overflow: "hidden", flex: "0 0 auto" }}>
              {p?.image ? <img src={p.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
            </div>
            <Text size="small" className="truncate" style={{ flex: 1 }}>{p?.title ?? id}</Text>
            {p && !p.inStock ? <Badge size="2xsmall" color="orange">Sold out</Badge> : null}
            <Button size="small" variant="transparent" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
            <Button size="small" variant="transparent" onClick={() => move(i, 1)} disabled={i === ids.length - 1}>↓</Button>
            <Button size="small" variant="transparent" onClick={() => onChange(ids.filter((x) => x !== id))}>Remove</Button>
          </div>
        )
      })}
    </div>
  )
}

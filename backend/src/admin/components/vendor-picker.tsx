import { Badge, Button, Input, Text } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useState } from "react"

/* Receiving's supplier comes from the QuickBooks vendor list
 * (GET /admin/qbo/vendors, read live), so a vendor added in QBO shows
 * up here and Push to QuickBooks bills the vendor picked, by Id, rather
 * than matching or creating one by name. When QBO isn't connected or
 * can't be read, the name is typed as before. */

export type SupplierFields = {
  name: string
  phone: string | null
  email: string | null
  address: string | null
  qboVendorId?: string | null
}

export type QboVendor = {
  id: string
  displayName: string
  email: string | null
  phone: string | null
  address: string | null
}

export type VendorList =
  | { status: "loading" }
  | { status: "ready"; vendors: QboVendor[] }
  | { status: "unavailable"; reason: string }

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()

export function useQboVendors(): VendorList & { refresh: () => void } {
  const [list, setList] = useState<VendorList>({ status: "loading" })
  const load = useCallback(() => {
    setList({ status: "loading" })
    fetch("/admin/qbo/vendors", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.connected) setList({ status: "unavailable", reason: "QuickBooks isn't connected" })
        else if (j.error) setList({ status: "unavailable", reason: `QuickBooks couldn't be read: ${j.error}` })
        else setList({ status: "ready", vendors: j.vendors ?? [] })
      })
      .catch((e) => setList({ status: "unavailable", reason: `QuickBooks couldn't be read: ${e?.message ?? e}` }))
  }, [])
  useEffect(load, [load])
  return { ...list, refresh: load }
}

/** Whether the supplier is good to save: a vendor from the list, or any
 *  typed name when the list can't be read. */
export function supplierReady(s: SupplierFields, list: VendorList): boolean {
  if (!s.name.trim()) return false
  if (list.status === "unavailable") return true
  return list.status === "ready" && !!s.qboVendorId && list.vendors.some((v) => v.id === s.qboVendorId)
}

/* QBO's details win; the invoice's fill in what QBO doesn't have. */
const fromVendor = (v: QboVendor, s: SupplierFields): SupplierFields => ({
  name: v.displayName,
  qboVendorId: v.id,
  phone: v.phone ?? s.phone,
  email: v.email ?? s.email,
  address: v.address ?? s.address,
})

export const VendorPicker: React.FC<{
  supplier: SupplierFields
  onChange: (s: SupplierFields) => void
  list: VendorList & { refresh: () => void }
}> = ({ supplier, onChange, list }) => {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const vendors = list.status === "ready" ? list.vendors : []
  const picked = vendors.find((v) => v.id === supplier.qboVendorId) ?? null

  /* A name read from an invoice (or an older draft) picks the vendor
   * with that exact name, ignoring case and spacing. */
  useEffect(() => {
    if (list.status !== "ready" || picked || !supplier.name.trim()) return
    const match = vendors.find((v) => norm(v.displayName) === norm(supplier.name))
    if (match) onChange(fromVendor(match, supplier))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.status, supplier.name, supplier.qboVendorId])

  const shown = useMemo(() => {
    const q = norm(search)
    return q ? vendors.filter((v) => norm(v.displayName).includes(q)) : vendors
  }, [vendors, search])

  if (list.status === "unavailable") {
    return (
      <div className="flex flex-col gap-1">
        <Input value={supplier.name} onChange={(e) => onChange({ ...supplier, name: e.target.value, qboVendorId: null })} />
        <Text size="xsmall" style={{ color: "#C98A00" }}>
          {list.reason}, so type the name. Push to QuickBooks matches it by name. <button type="button" onClick={list.refresh} style={{ textDecoration: "underline" }}>Try again</button>
        </Text>
      </div>
    )
  }
  if (list.status === "loading") {
    return <Input disabled placeholder="Loading QuickBooks vendors…" value="" onChange={() => {}} />
  }

  if (picked && !open) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <Text size="base" weight="plus">{picked.displayName}</Text>
        <Badge color="green" size="2xsmall">QuickBooks vendor</Badge>
        <Button variant="transparent" size="small" onClick={() => { setSearch(""); setOpen(true) }}>Change</Button>
      </div>
    )
  }

  const unmatched = !picked && supplier.name.trim()
  const staleId = !picked && supplier.qboVendorId
  return (
    <div className="flex flex-col gap-1">
      {staleId ? (
        <Text size="xsmall" style={{ color: "#C98A00" }}>
          "{supplier.name}" is no longer an active QuickBooks vendor. Pick one below.
        </Text>
      ) : unmatched ? (
        <Text size="xsmall" style={{ color: "#C98A00" }}>
          "{supplier.name}" isn't a QuickBooks vendor. Pick it below, or add it in QuickBooks and press Refresh.
        </Text>
      ) : null}
      <div className="flex gap-2">
        <Input autoFocus={open} placeholder={`Search ${vendors.length} QuickBooks vendors`} value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <Button variant="secondary" size="small" onClick={list.refresh}>Refresh</Button>
        {picked && <Button variant="transparent" size="small" onClick={() => setOpen(false)}>Cancel</Button>}
      </div>
      <div style={{ border: "1px solid #E5E1D6", maxHeight: 220, overflowY: "auto", background: "#fff" }}>
        {shown.length === 0 ? (
          <Text size="small" className="text-ui-fg-muted" style={{ padding: "8px 10px" }}>
            No vendor matches "{search}". Add it in QuickBooks, then press Refresh.
          </Text>
        ) : shown.map((v) => (
          <button key={v.id} type="button"
            onClick={() => { onChange(fromVendor(v, supplier)); setOpen(false); setSearch("") }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "6px 10px",
              borderTop: "1px solid #F3F1EA", background: v.id === supplier.qboVendorId ? "#F3F1EA" : "transparent",
            }}>
            <Text size="small" weight="plus">{v.displayName}</Text>
            {(v.email || v.phone) && (
              <Text size="xsmall" className="text-ui-fg-muted">{[v.email, v.phone].filter(Boolean).join(" · ")}</Text>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

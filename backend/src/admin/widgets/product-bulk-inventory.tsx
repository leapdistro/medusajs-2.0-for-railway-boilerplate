import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
  toast,
} from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/**
 * Bulk inventory setter — single click stocks every variant of a
 * product at a chosen location. Solves the multi-axis pain (e.g.,
 * the 6-variant waterpipe) where every variant otherwise needs to
 * be expanded + level-added by hand.
 *
 * Modes:
 *   - Set: overwrites every variant's stocked_quantity to `value`
 *   - Add: increments every variant by `+value` (restock pattern)
 *
 * Pool products (Flower QP/Half/LB sharing one InventoryItem) only
 * update the shared pool once — backend dedupes by inventory_item_id.
 */

type Location = { id: string; name: string }

const ProductBulkInventoryWidget = ({ data: product }: DetailWidgetProps<AdminProduct>) => {
  const [locations, setLocations] = useState<Location[]>([])
  const [locationId, setLocationId] = useState<string>("")
  const [mode, setMode] = useState<"set" | "add">("set")
  const [value, setValue] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [lastResult, setLastResult] = useState<string | null>(null)

  const variantCount = product?.variants?.length ?? 0

  /* Load stock locations once on mount. Defaults selected to MBS US
   * Warehouse if it exists (operator's primary location), else the
   * first location returned. */
  useEffect(() => {
    let cancelled = false
    fetch("/admin/stock-locations", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const list = (j.stock_locations ?? []).map((l: any) => ({ id: l.id, name: l.name })) as Location[]
        setLocations(list)
        const preferred = list.find((l) => /MBS\s*US/i.test(l.name)) ?? list[0]
        if (preferred) setLocationId(preferred.id)
      })
      .catch(() => { /* silent — widget shows "no locations" if this fails */ })
    return () => { cancelled = true }
  }, [])

  const apply = useCallback(async () => {
    if (!product?.id) return
    const qty = Number(value)
    if (!Number.isFinite(qty) || qty < 0) {
      toast.error("Quantity must be a non-negative number")
      return
    }
    if (!locationId) {
      toast.error("Pick a location first")
      return
    }
    setBusy(true)
    setLastResult(null)
    try {
      const res = await fetch(`/admin/products/${product.id}/bulk-inventory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ locationId, mode, quantity: qty }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? `Apply failed (${res.status})`)
      }
      const summary = json.summary
      const verb = mode === "set" ? "set to" : "increased by"
      const msg = `${summary.inventoryItemsAffected} inventory item(s) ${verb} ${qty}`
      toast.success("Bulk inventory applied", { description: msg })
      setLastResult(msg)
    } catch (e: any) {
      toast.error("Couldn't apply bulk inventory", { description: e?.message ?? "Network error" })
    } finally {
      setBusy(false)
    }
  }, [product?.id, locationId, mode, value])

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Bulk Inventory</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          {variantCount} variant{variantCount === 1 ? "" : "s"}
        </Text>
      </div>
      <div className="flex flex-col gap-y-4 px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          Stocks every variant at once. Pool products (Flower QP/½/LB sharing
          one inventory item) update the shared pool just once — no
          double-counting.
        </Text>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus">Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <Select.Trigger>
                <Select.Value placeholder={locations.length === 0 ? "Loading…" : "Pick location"} />
              </Select.Trigger>
              <Select.Content>
                {locations.map((l) => (
                  <Select.Item key={l.id} value={l.id}>{l.name}</Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "set" | "add")}>
              <Select.Trigger><Select.Value /></Select.Trigger>
              <Select.Content>
                <Select.Item value="set">Set quantity</Select.Item>
                <Select.Item value="add">Add to quantity</Select.Item>
              </Select.Content>
            </Select>
          </div>

          <div className="flex flex-col gap-y-2">
            <Label size="small" weight="plus">{mode === "set" ? "Quantity" : "Add amount"}</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
            />
          </div>
        </div>

        <div className="flex justify-between items-center">
          {lastResult ? (
            <Text size="small" style={{ color: "#549402" }}>✓ {lastResult}</Text>
          ) : <span />}
          <Button
            variant="primary"
            disabled={busy || !value || !locationId || variantCount === 0}
            onClick={apply}
          >
            {busy ? "Applying…" : `${mode === "set" ? "Set" : "Add"} on all ${variantCount} variants`}
          </Button>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default ProductBulkInventoryWidget

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Badge, Container, Heading, Text } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/**
 * Pool inventory clarification widget — every product detail page.
 *
 * The default Medusa admin shows each variant's inventory level
 * separately. For pool products (Flower QP/Half/LB sharing one
 * InventoryItem via required_quantity 1/2/4, Pre-Rolls' single Box
 * variant, any future receiving creation), the SAME pool count
 * appears under every variant — visually misleading (8 QPs in the
 * pool looks like 8+8+8 = 24 units).
 *
 * This widget surfaces the pool reality:
 *   Pool: 8 QP · Available now: 8 × QP / 4 × ½ / 2 × LB
 *
 * Renders nothing for regular non-pool products (multi-item variants).
 * The /admin/products/:id/pool-inventory endpoint returns isPool:false
 * in that case.
 */

type Variant = {
  id: string
  title: string
  sku: string | null
  requiredQuantity: number
  sellable: number
}

type PoolSummary =
  | { isPool: false }
  | {
      isPool: true
      poolUnitLabel: string
      stocked: number
      reserved: number
      available: number
      variants: Variant[]
    }

const ProductPoolInventoryWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const [summary, setSummary] = useState<PoolSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/products/${data.id}/pool-inventory`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as PoolSummary
      setSummary(json)
    } catch (e: any) {
      setError(e?.message ?? "Failed to load pool inventory")
    }
  }, [data?.id])

  useEffect(() => { refresh() }, [refresh])

  /* Hide entirely while loading + when product is not a pool. The default
   * Medusa per-variant inventory tiles already cover non-pool cases. */
  if (error || !summary || summary.isPool === false) return null

  const { poolUnitLabel, stocked, reserved, available, variants } = summary

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Pool Inventory</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            All variants below share ONE pool. Each variant&apos;s row in the
            inventory tile shows the same pool count — that&apos;s expected.
          </Text>
        </div>
        <Badge color={available > 0 ? "green" : "orange"} size="large">
          {available} {poolUnitLabel}{available === 1 ? "" : "s"} available
        </Badge>
      </div>

      <div className="px-6 py-4">
        <div style={{ fontFamily: "monospace", fontSize: 13 }} className="flex flex-col gap-1">
          <Row label={`Stocked ${poolUnitLabel}s`} value={String(stocked)} />
          <Row label={`Reserved ${poolUnitLabel}s`} value={String(reserved)} />
          <Row label={`Available ${poolUnitLabel}s`} value={String(available)} />
        </div>
      </div>

      <div className="px-6 py-4">
        <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
          Sellable now (per variant)
        </Text>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
          {variants.map((v) => (
            <div
              key={v.id}
              style={{ border: "1px solid #E5E1D6", padding: 12, background: "#fff" }}
            >
              <Text size="small" weight="plus">{v.title}</Text>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
                <Text size="xsmall" className="text-ui-fg-muted">
                  {v.requiredQuantity} {poolUnitLabel}{v.requiredQuantity === 1 ? "" : "s"} / unit
                </Text>
                <Text size="base" weight="plus" style={{ fontFamily: "monospace" }}>
                  {v.sellable}
                </Text>
              </div>
              {v.sku && (
                <Text size="xsmall" className="text-ui-fg-muted" style={{ marginTop: 2, fontFamily: "monospace" }}>
                  {v.sku}
                </Text>
              )}
            </div>
          ))}
        </div>
      </div>
    </Container>
  )
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between" }}>
    <span style={{ color: "#888" }}>{label}</span>
    <span>{value}</span>
  </div>
)

export const config = defineWidgetConfig({
  zone: "product.details.before",
})

export default ProductPoolInventoryWidget

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"

type Addr = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  province?: string | null
  postal_code?: string | null
  country_code?: string | null
  phone?: string | null
} | null | undefined

type OrderLite = {
  id: string
  email?: string
  shipping_address?: Addr
  billing_address?: Addr
}

/**
 * Order detail widget — surfaces the per-address fields Medusa's default
 * Customer panel collapses (first_name / last_name / phone / address_2
 * shown only at the customer level, not under each address). Operators
 * processing an order need to see exactly what the buyer typed for each
 * address: deli "ship to" name might differ from billing legal name,
 * phone number per address matters for shipping carrier issues, etc.
 *
 * Data comes from the order itself (no extra fetch — DetailWidgetProps
 * passes the full order with both addresses already expanded).
 */
const OrderAddressesWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const [order, setOrder] = useState<OrderLite>(data)
  useEffect(() => { setOrder(data) }, [data])

  /* If for any reason the prop didn't include phone or other fields,
   * fetch with explicit field expansion as a defensive backstop. */
  useEffect(() => {
    if (!data?.id) return
    if (data.shipping_address?.phone || data.billing_address?.phone) return
    let cancelled = false
    fetch(`/admin/orders/${data.id}?fields=id,email,*shipping_address,*billing_address`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.order) setOrder(j.order) })
      .catch(() => { /* fall back to prop data */ })
    return () => { cancelled = true }
  }, [data?.id, data.shipping_address?.phone, data.billing_address?.phone])

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Address details</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Per-address fields exactly as the buyer entered them at checkout.
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
        <AddressBlock label="Billing"  addr={order.billing_address} />
        <AddressBlock label="Shipping" addr={order.shipping_address} className="md:border-l md:border-ui-border-base" />
      </div>
    </Container>
  )
}

const Row = ({ label, value }: { label: string; value?: string | null }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <Text size="xsmall" className="text-ui-fg-subtle uppercase tracking-wider" style={{ minWidth: "92px" }}>{label}</Text>
    <Text size="small" className="text-ui-fg-base text-right break-words">
      {value && value.trim().length > 0 ? value : <span className="text-ui-fg-muted">—</span>}
    </Text>
  </div>
)

const AddressBlock = ({ label, addr, className }: { label: string; addr: Addr; className?: string }) => (
  <div className={`px-6 py-4 ${className ?? ""}`}>
    <Heading level="h3" className="mb-3 text-ui-fg-base">{label}</Heading>
    {!addr ? (
      <Text size="small" className="text-ui-fg-muted">No {label.toLowerCase()} address on this order.</Text>
    ) : (
      <div className="flex flex-col gap-y-1">
        <Row label="First name" value={addr.first_name} />
        <Row label="Last name"  value={addr.last_name} />
        <Row label="Company"    value={addr.company} />
        <Row label="Address 1"  value={addr.address_1} />
        <Row label="Address 2"  value={addr.address_2} />
        <Row label="City"       value={addr.city} />
        <Row label="State"      value={addr.province} />
        <Row label="ZIP"        value={addr.postal_code} />
        <Row label="Country"    value={addr.country_code?.toUpperCase()} />
        <Row label="Phone"      value={addr.phone} />
      </div>
    )}
  </div>
)

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderAddressesWidget

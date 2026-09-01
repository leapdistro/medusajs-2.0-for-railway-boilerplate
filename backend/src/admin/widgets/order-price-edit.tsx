import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Input, Text, toast, Tooltip } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useState } from "react"

/**
 * Per-line unit-price editor for Net-15, unfulfilled, unpushed orders.
 *
 * Mirror of POST /admin/orders/:id/line-items/:itemId/price guards:
 *   - order.fulfillments is empty (or all canceled)
 *   - order.metadata.qbo_invoice_id is unset
 *   - customer.metadata.payment_terms === "net15"
 *   - no captured card payment on the order
 *
 * If any guard fails, the widget shows a disabled Input with a Tooltip
 * explaining why. The backend re-validates so the guard is defense-in-
 * depth — never trust a client-side "disabled".
 *
 * On save, the row's input becomes read-only, we call the backend, and
 * on success we refetch the order so the Summary card up top refreshes
 * with the new total.
 */

type OrderLite = {
  id: string
  customer_id?: string | null
  metadata?: Record<string, any> | null
  items?: Array<{
    id: string
    product_title?: string | null
    title?: string | null
    variant_title?: string | null
    quantity?: number | { value?: string }
    raw_quantity?: number | { value?: string } | null
    detail?: { quantity?: number | { value?: string } | null } | null
    unit_price?: number | string | { value?: string }
  }>
  fulfillments?: Array<{ id: string; canceled_at?: string | null }>
  payment_collections?: Array<{
    payments?: Array<{ id: string; captured_at?: string | null; canceled_at?: string | null }>
  }>
}

const toNumber = (v: any): number => {
  if (v == null) return 0
  if (typeof v === "number") return v
  if (typeof v === "string") return Number(v)
  if (typeof v === "object" && "value" in v) return Number(v.value)
  return Number(v)
}
/* Same fallback ladder the backend uses — items.quantity zeroes after
 * a fulfillment cancel, but raw_quantity / detail.quantity retain
 * the original ordered count. */
const resolveQty = (item: NonNullable<OrderLite["items"]>[number]): number => {
  const q = toNumber(item.quantity)
  if (q > 0) return q
  const dq = toNumber(item.detail?.quantity)
  if (dq > 0) return dq
  return toNumber(item.raw_quantity)
}
const fmtUsd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)

const OrderPriceEditWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const [order, setOrder] = useState<OrderLite | null>(data)
  const [customerPaymentTerms, setCustomerPaymentTerms] = useState<string | null>(null)
  const [loadingCustomer, setLoadingCustomer] = useState(true)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(
        `/admin/orders/${data.id}?fields=id,customer_id,metadata,items.id,items.product_title,items.title,items.variant_title,items.quantity,items.raw_quantity,items.detail.quantity,items.unit_price,fulfillments.id,fulfillments.canceled_at,payment_collections.payments.id,payment_collections.payments.captured_at,payment_collections.payments.canceled_at`,
        { credentials: "include" },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setOrder(json?.order ?? data)
    } catch {
      setOrder(data)
    }
  }, [data])

  const loadCustomer = useCallback(async (customerId: string | null | undefined) => {
    if (!customerId) { setCustomerPaymentTerms(null); setLoadingCustomer(false); return }
    setLoadingCustomer(true)
    try {
      const res = await fetch(`/admin/customers/${customerId}?fields=id,metadata`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const terms = (json?.customer?.metadata?.payment_terms as string | undefined) ?? null
      setCustomerPaymentTerms(terms)
    } catch {
      setCustomerPaymentTerms(null)
    } finally {
      setLoadingCustomer(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { loadCustomer(order?.customer_id) }, [order?.customer_id, loadCustomer])

  const guardMessage = useMemo(() => {
    if (!order) return "Loading…"
    const hasActiveFulfillment = (order.fulfillments ?? []).some((f) => !f?.canceled_at)
    if (hasActiveFulfillment) return "Order has been fulfilled — cancel the fulfillment first."
    if (order.metadata?.qbo_invoice_id) return `Already pushed to QuickBooks as Invoice ${order.metadata.qbo_invoice_id}. Void it in QBO before editing prices.`
    const captured = (order.payment_collections ?? [])
      .flatMap((pc) => pc?.payments ?? [])
      .some((p) => !!p?.captured_at && !p?.canceled_at)
    if (captured) return "Order has a captured card payment — editing the price would desync the invoice from what was charged."
    if (loadingCustomer) return "Loading customer terms…"
    if (customerPaymentTerms !== "net15") return "Price editing is only enabled for Net-15 buyers."
    return null
  }, [order, customerPaymentTerms, loadingCustomer])

  const canEdit = guardMessage == null

  if (!order?.items || order.items.length === 0) return null

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Edit Line Prices</Heading>
        {canEdit
          ? <Text size="small" className="text-ui-fg-subtle">Net-15, unfulfilled, unpushed — edits allowed</Text>
          : <Text size="small" className="text-ui-fg-subtle">{guardMessage}</Text>
        }
      </div>
      <div className="px-6 py-4 flex flex-col gap-3">
        {(order.items ?? []).map((item) => (
          <LineRow
            key={item.id}
            orderId={order.id}
            item={item}
            disabled={!canEdit}
            disabledReason={guardMessage ?? ""}
            onSaved={refresh}
          />
        ))}
      </div>
    </Container>
  )
}

const LineRow = ({
  orderId, item, disabled, disabledReason, onSaved,
}: {
  orderId: string
  item: NonNullable<OrderLite["items"]>[number]
  disabled: boolean
  disabledReason: string
  onSaved: () => void
}) => {
  const currentPrice = toNumber(item.unit_price)
  const quantity = resolveQty(item)
  const [value, setValue] = useState(currentPrice.toString())
  const [busy, setBusy] = useState(false)
  useEffect(() => { setValue(currentPrice.toString()) }, [currentPrice])

  const dirty = Math.abs(Number(value) - currentPrice) > 0.0001 && Number.isFinite(Number(value))
  const label = item.product_title ?? item.title ?? "(untitled)"
  const variantLabel = item.variant_title && item.variant_title !== label ? ` · ${item.variant_title}` : ""

  const submit = async () => {
    const nextPrice = Number(value)
    if (!Number.isFinite(nextPrice) || nextPrice < 0) {
      toast.error("Price must be a non-negative number")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/line-items/${item.id}/price`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unit_price: nextPrice }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json?.message ?? `Failed (HTTP ${res.status})`)
        return
      }
      if (json?.changed === false) {
        toast.info("Price unchanged")
      } else {
        toast.success(`${label}: ${fmtUsd(currentPrice)} → ${fmtUsd(nextPrice)}`)
        onSaved()
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  const input = (
    <Input
      type="number"
      step="0.01"
      min={0}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      disabled={disabled || busy}
      className="w-32"
    />
  )

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <Text size="small" weight="plus" className="truncate">
          {label}<span className="text-ui-fg-subtle">{variantLabel}</span>
        </Text>
        <Text size="xsmall" className="text-ui-fg-subtle">
          qty {quantity} · line total {fmtUsd(Number(value || "0") * quantity)}
        </Text>
      </div>
      {disabled
        ? <Tooltip content={disabledReason}><div>{input}</div></Tooltip>
        : input
      }
      <Button
        variant="secondary"
        size="small"
        onClick={submit}
        isLoading={busy}
        disabled={disabled || !dirty || busy}
      >
        Save
      </Button>
    </div>
  )
}

export const config = defineWidgetConfig({
  /* Renders in the right-hand sidebar under Summary (Medusa admin
   * order detail is a two-column layout: items on the left, Summary
   * + Customer + Notes on the right). Sits below Summary so operators
   * see the current totals next to the editable prices. */
  zone: "order.details.side.after",
})

export default OrderPriceEditWidget

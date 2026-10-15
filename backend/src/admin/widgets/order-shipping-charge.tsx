import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type OrderLite = { id: string; display_id?: number | string }
type ShippingMethod = { id: string; name?: string | null; amount?: number | string | null }
type ShippingOption = { id: string; name: string }

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" })

/**
 * Order detail widget — add a shipping charge to an existing order
 * (POST /admin/orders/:id/shipping-charge). For orders that were placed
 * as Local Pickup, or shipped at a different cost than checkout quoted.
 *
 * The option list is the store's live shipping options; it only names
 * the charge. The amount is whatever the operator types. The QBO invoice
 * picks the charge up as a Shipping line through the normal order sync.
 */
const OrderShippingChargeWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const [methods, setMethods] = useState<ShippingMethod[]>([])
  const [shippingTotal, setShippingTotal] = useState(0)
  const [options, setOptions] = useState<ShippingOption[]>([])
  const [optionId, setOptionId] = useState("")
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(
        `/admin/orders/${data.id}?fields=id,shipping_total,shipping_methods.id,shipping_methods.name,shipping_methods.amount`,
        { credentials: "include", cache: "no-store" },
      )
      const json = await res.json()
      setMethods(json?.order?.shipping_methods ?? [])
      setShippingTotal(Number(json?.order?.shipping_total ?? 0))
    } catch {
      /* Leave the last-known list; the form still works. */
    }
  }, [data?.id])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    fetch("/admin/shipping-options?fields=id,name&limit=100", { credentials: "include" })
      .then((r) => r.json())
      .then((json) => {
        const list = ((json?.shipping_options ?? []) as ShippingOption[])
          .filter((o) => o?.id && o?.name)
        setOptions(list)
        /* Default to a shipping option rather than pickup — adding a
         * charge almost always means the order is being shipped. */
        const preferred = list.find((o) => !/pick ?up/i.test(o.name)) ?? list[0]
        if (preferred) setOptionId(preferred.id)
      })
      .catch(() => setOptions([]))
  }, [])

  const value = Number(amount)
  const valid = Number.isFinite(value) && value > 0 && !!optionId

  const submit = async () => {
    if (!valid) return
    const optionName = options.find((o) => o.id === optionId)?.name ?? "shipping"
    if (!confirm(`Add ${fmtUsd(value)} ${optionName} to order #${data.display_id ?? ""}? The QuickBooks invoice will update to match.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/orders/${data.id}/shipping-charge`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: value, shipping_option_id: optionId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) throw new Error(json?.message ?? `Failed (${res.status})`)
      toast.success(`${fmtUsd(value)} shipping added — QuickBooks invoice is updating`)
      setAmount("")
      await refresh()
      /* Order totals elsewhere on the page come from the admin's own
       * cache; reload so the summary shows the new total. */
      setTimeout(() => window.location.reload(), 1200)
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't add the shipping charge")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Shipping Charge</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Current shipping: {fmtUsd(shippingTotal)}
          {methods.length > 0 && ` · ${Array.from(new Set(methods.map((m) => m.name).filter(Boolean))).join(", ")}`}
        </Text>
      </div>
      <div className="px-6 py-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label size="xsmall" weight="plus">Shipping method</Label>
          <select
            className="h-8 border border-ui-border-base bg-ui-bg-field px-2 text-sm rounded-md"
            value={optionId}
            onChange={(e) => setOptionId(e.target.value)}
          >
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label size="xsmall" weight="plus">Amount to add (USD)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="60.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <Button variant="secondary" size="small" onClick={submit} isLoading={busy} disabled={!valid || busy}>
          Add shipping charge
        </Button>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default OrderShippingChargeWidget

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
 * Order detail widget — change an order's shipping
 * (POST /admin/orders/:id/shipping-charge):
 *   Set total shipping — replaces every current charge with one amount
 *     (lower, higher or 0). Previewed first; the confirm shows before → after.
 *   Add a charge — adds on top, e.g. a Local Pickup order that ships.
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
  const [mode, setMode] = useState<"set" | "add">("set")
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
  const valid = amount.trim() !== "" && Number.isFinite(value) && (mode === "set" ? value >= 0 : value > 0) && !!optionId

  const post = async (preview: boolean) => {
    const res = await fetch(`/admin/orders/${data.id}/shipping-charge`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: value, shipping_option_id: optionId, mode, preview }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.ok) throw new Error(json?.message ?? `Failed (${res.status})`)
    return json as { before: { shipping: number; total: number }; after: { shipping: number; total: number } }
  }

  const submit = async () => {
    if (!valid) return
    const optionName = options.find((o) => o.id === optionId)?.name ?? "shipping"
    setBusy(true)
    try {
      /* Dry run first: the confirm shows exactly what will change. */
      const p = await post(true)
      const question = mode === "set"
        ? `Set shipping on order #${data.display_id ?? ""} to ${fmtUsd(value)} (${optionName})?\n\nShipping: ${fmtUsd(p.before.shipping)} → ${fmtUsd(p.after.shipping)}\nOrder total: ${fmtUsd(p.before.total)} → ${fmtUsd(p.after.total)}\n\nThe QuickBooks invoice will update to match.`
        : `Add ${fmtUsd(value)} ${optionName} to order #${data.display_id ?? ""}?\n\nShipping: ${fmtUsd(p.before.shipping)} → ${fmtUsd(p.after.shipping)}\nOrder total: ${fmtUsd(p.before.total)} → ${fmtUsd(p.after.total)}\n\nThe QuickBooks invoice will update to match.`
      if (!confirm(question)) return
      await post(false)
      toast.success(mode === "set"
        ? `Shipping set to ${fmtUsd(value)} — QuickBooks invoice is updating`
        : `${fmtUsd(value)} shipping added — QuickBooks invoice is updating`)
      setAmount("")
      await refresh()
      /* Order totals elsewhere on the page come from the admin's own
       * cache; reload so the summary shows the new total. */
      setTimeout(() => window.location.reload(), 1200)
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't change the shipping")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Shipping Charge</Heading>
        <Text size="small" className="text-ui-fg-subtle">Current shipping: {fmtUsd(shippingTotal)}</Text>
        {methods.length > 1 && methods.map((m) => (
          <Text key={m.id} size="xsmall" className="text-ui-fg-subtle">· {m.name ?? "Shipping"} {fmtUsd(Number(m.amount ?? 0))}</Text>
        ))}
      </div>
      <div className="px-6 py-4 flex flex-col gap-3">
        <div className="flex gap-2">
          <Button size="small" variant={mode === "set" ? "primary" : "secondary"} onClick={() => setMode("set")}>Set total shipping</Button>
          <Button size="small" variant={mode === "add" ? "primary" : "secondary"} onClick={() => setMode("add")}>Add a charge</Button>
        </div>
        <Text size="xsmall" className="text-ui-fg-subtle">
          {mode === "set"
            ? "Replaces every shipping charge on the order with this one amount. Use it to lower or remove shipping (0 = free)."
            : "Adds this amount on top of the shipping already on the order."}
        </Text>
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
          <Label size="xsmall" weight="plus">{mode === "set" ? "New total shipping (USD)" : "Amount to add (USD)"}</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder={mode === "set" ? "65.00" : "60.00"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <Button variant="secondary" size="small" onClick={submit} isLoading={busy} disabled={!valid || busy}>
          {mode === "set" ? "Set shipping" : "Add shipping charge"}
        </Button>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default OrderShippingChargeWidget

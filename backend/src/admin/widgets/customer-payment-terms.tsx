import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Switch, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type CustomerLite = {
  id: string
  email?: string
  metadata?: Record<string, any> | null
}

/**
 * Customer payment terms — Net 15 is a privilege admin grants to
 * specific approved buyers. Default for everyone else is credit card
 * at checkout (handled by KAJA / Authorize.net in Step 3).
 *
 * Stored on customer.metadata.payment_terms === "net15" (or absent).
 * The QBO push subscriber and storefront checkout both read this:
 *   - "net15"        → Net 15 path: Invoice in QBO with SalesTermRef=Net 15,
 *                      UNPAID; storefront checkout shows "no card needed"
 *   - null / absent  → Credit card path: KAJA charges at checkout;
 *                      QBO Payment posts on fulfillment marked PAID
 */
const CustomerPaymentTermsWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const [customer, setCustomer] = useState<CustomerLite | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/customers/${data.id}?fields=id,email,metadata`, {
        credentials: "include",
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCustomer(json?.customer ?? null)
    } catch {
      setCustomer(data)
    } finally {
      setLoading(false)
    }
  }, [data])

  useEffect(() => { refresh() }, [refresh])

  const isNet15 = customer?.metadata?.payment_terms === "net15"

  const onToggle = async (checked: boolean) => {
    if (!customer?.id) return
    const requested = checked ? "net15" : null
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${customer.id}/payment-terms`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: requested }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(
        requested === "net15"
          ? "Net 15 enabled — customer will be invoiced (no card at checkout)"
          : "Net 15 disabled — customer pays by card at checkout"
      )
      await refresh()
    } catch (e: any) {
      toast.error("Could not update: " + (e?.message ?? "unknown"))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h2">Payment Terms</Heading>
            <Text size="small" className="text-ui-fg-muted">Loading…</Text>
          </div>
        </div>
      </Container>
    )
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">Payment Terms</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Default: customer pays by card at checkout (KAJA / Credit Card). Enable
            Net 15 only for approved buyers who pay by check within 15 days.
          </Text>
          <Text size="small" className="text-ui-fg-muted" style={{ marginTop: 6 }}>
            Current: <strong>{isNet15 ? "Net 15 — invoiced by check" : "Credit card at checkout"}</strong>
          </Text>
        </div>
        <div className="flex items-center gap-2" style={{ minWidth: 180, justifyContent: "flex-end" }}>
          <Text size="small">Net 15</Text>
          <Switch checked={isNet15} onCheckedChange={onToggle} disabled={busy} />
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerPaymentTermsWidget

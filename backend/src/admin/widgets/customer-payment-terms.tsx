import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Select, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type CustomerLite = {
  id: string
  email?: string
  metadata?: Record<string, any> | null
}

/**
 * Customer payment terms — controls whether this customer pays via
 * KAJA at checkout (default) or via check on Net 15 terms (operator
 * decision per customer). Stored on customer.metadata.payment_terms.
 *
 * The QBO push subscriber reads this at fulfillment time to decide
 * Invoice shape: PAID + KAJA Payment, or UNPAID + SalesTerm Net 15.
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

  const currentTerms = (customer?.metadata?.payment_terms ?? "default") as "default" | "net15"

  const onChange = async (next: string) => {
    if (!customer?.id) return
    const requested = next === "default" ? null : next
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
          ? "Payment terms set to Net 15 — Check"
          : "Payment terms reset to default (KAJA Credit Card)"
      )
      await refresh()
    } catch (e: any) {
      toast.error("Could not update terms: " + (e?.message ?? "unknown"))
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
            How this customer pays. KAJA = card charged at checkout (most buyers).
            Net 15 = invoice mailed, customer pays by check within 15 days.
          </Text>
        </div>
        <div style={{ minWidth: 240 }}>
          <Select value={currentTerms} onValueChange={onChange} disabled={busy}>
            <Select.Trigger>
              <Select.Value placeholder="Choose terms" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="default">KAJA Credit Card (default)</Select.Item>
              <Select.Item value="net15">Net 15 — Check</Select.Item>
            </Select.Content>
          </Select>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerPaymentTermsWidget

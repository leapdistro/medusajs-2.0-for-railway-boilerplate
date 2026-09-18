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
 * Label printing — a privilege admin grants per buyer, same shape as the
 * Net 15 toggle next to it (customer-payment-terms.tsx).
 *
 * Stored on customer.metadata.labels_enabled === true (or absent).
 * The storefront reads it in three places:
 *   - PDP "Print labels" block
 *   - COA library row actions
 *   - /labels/<slug>/<weight>, which 404s when it isn't true — the
 *     print page is rendered per request precisely so this check runs
 *
 * OFF by default. Printed labels carry our branding and a COA QR onto a
 * buyer's retail shelf, so nobody prints until an operator says so.
 */
const CustomerLabelPrintingWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
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

  const enabled = customer?.metadata?.labels_enabled === true

  const onToggle = async (checked: boolean) => {
    if (!customer?.id) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${customer.id}/label-printing`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: checked }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(
        checked
          ? "Label printing enabled — buyer can print labels for every weight"
          : "Label printing disabled — print buttons and label pages are hidden"
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
            <Heading level="h2">Label Printing</Heading>
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
          <Heading level="h2">Label Printing</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Off by default. Turn on for buyers who repack flower and print their own
            shelf labels (1g through QP, each with the strain&apos;s COA QR code).
          </Text>
          <Text size="small" className="text-ui-fg-muted" style={{ marginTop: 6 }}>
            Current: <strong>{enabled ? "Can print labels" : "Cannot print labels"}</strong>
          </Text>
        </div>
        <div className="flex items-center gap-2" style={{ minWidth: 180, justifyContent: "flex-end" }}>
          <Text size="small">Labels</Text>
          <Switch checked={enabled} onCheckedChange={onToggle} disabled={busy} />
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerLabelPrintingWidget

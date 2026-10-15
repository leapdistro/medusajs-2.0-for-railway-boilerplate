import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useState } from "react"

type Changed = { display_id: number; from: string | null; to: string | null; paid: number; balance: number }

const STATUS_LABEL: Record<string, string> = {
  paid: "paid",
  partially_paid: "partly paid",
  unpaid: "unpaid",
  voided: "voided",
}

/**
 * Orders list — re-check every open QuickBooks invoice for payments
 * (POST /admin/qbo/refresh-payments). Catch-up for payments whose QBO
 * webhook never arrived; orders paid in full are marked paid in Medusa.
 */
const OrdersQboPaymentRefreshWidget = () => {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ checked: number; changed: Changed[]; failed: number } | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch("/admin/qbo/refresh-payments", { method: "POST", credentials: "include" })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.message ?? `Failed (${res.status})`)
      setResult({ checked: json.checked, changed: json.changed ?? [], failed: (json.failed ?? []).length })
      toast.success(`Checked ${json.checked} open invoices`, {
        description: `${(json.changed ?? []).length} updated from QuickBooks`,
      })
    } catch (e: any) {
      toast.error("Couldn't check QuickBooks payments", { description: e?.message ?? "Network error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="flex flex-col gap-3 px-6 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Heading level="h2">QuickBooks payments</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Re-check open invoices and mark orders paid that were paid in QuickBooks.
          </Text>
        </div>
        <Button variant="secondary" onClick={run} isLoading={busy}>Check QuickBooks payments</Button>
      </div>
      {result && (
        <Text size="small" className="text-ui-fg-subtle">
          Checked {result.checked}.{" "}
          {result.changed.length === 0
            ? "Nothing new."
            : result.changed
                .map((c) => `#${c.display_id} ${STATUS_LABEL[c.to ?? ""] ?? c.to}${c.to === "partially_paid" ? ` ($${c.balance.toFixed(2)} due)` : ""}`)
                .join(" · ")}
          {result.failed > 0 ? ` · ${result.failed} couldn't be read` : ""}
        </Text>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.list.before",
})

export default OrdersQboPaymentRefreshWidget

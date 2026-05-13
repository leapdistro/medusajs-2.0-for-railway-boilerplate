import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type OrderLite = {
  id: string
  display_id?: number | string
  metadata?: Record<string, any> | null
}

/**
 * Order detail widget — shows QBO push status for this order.
 *
 *   Not pushed yet (and no error) → "Push to QuickBooks" button
 *   Pushed                        → "✓ Pushed · Invoice #N" + link to QBO
 *   Push failed                   → red error banner + "Retry Push" button
 */
const OrderQboStatusWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const [order, setOrder] = useState<OrderLite | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/orders/${data.id}?fields=id,display_id,metadata`, {
        credentials: "include",
      })
      const json = await res.json()
      setOrder(json?.order ?? data)
    } catch {
      setOrder(data)
    }
  }, [data])

  useEffect(() => { refresh() }, [refresh])

  const meta = (order?.metadata ?? {}) as Record<string, any>
  const invoiceId = meta.qbo_invoice_id as string | undefined
  const pushedAt = meta.qbo_pushed_at as string | undefined
  const paymentId = meta.qbo_payment_id as string | undefined
  const pushError = meta.qbo_push_error as string | undefined
  const pushErrorAt = meta.qbo_push_error_at as string | undefined

  const onPush = async () => {
    if (!order?.id) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/orders/${order.id}/push-to-qbo`, {
        method: "POST",
        credentials: "include",
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? json?.code ?? `Push failed (${res.status})`)
      toast.success("Pushed to QuickBooks", {
        description: paymentId
          ? `Invoice ${json.invoiceId} · paid`
          : `Invoice ${json.invoiceId}`,
      })
      await refresh()
    } catch (e: any) {
      toast.error("Push failed", { description: e?.message ?? "Network error" })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">QuickBooks</Heading>
          {invoiceId ? (
            <Text size="small" className="text-ui-fg-subtle">
              Auto-pushed when this order was fulfilled. Use Retry only if data needs re-syncing.
            </Text>
          ) : pushError ? (
            <Text size="small" className="text-ui-fg-subtle">
              The auto-push at fulfillment failed. Fix the issue and retry.
            </Text>
          ) : (
            <Text size="small" className="text-ui-fg-subtle">
              Order hasn't been pushed yet. Auto-push fires when this order is marked fulfilled, or push manually here.
            </Text>
          )}
        </div>
        <div className="flex items-center gap-2">
          {invoiceId ? (
            <Badge color="purple">
              ✓ Pushed · Invoice {invoiceId}{paymentId ? " · paid" : ""}
            </Badge>
          ) : null}
          <Button
            variant={pushError ? "danger" : invoiceId ? "secondary" : "primary"}
            onClick={onPush}
            isLoading={busy}
          >
            {invoiceId ? "Retry Push" : pushError ? "Retry Push" : "Push to QuickBooks"}
          </Button>
        </div>
      </div>

      {pushError && !invoiceId ? (
        <div className="px-6 py-4">
          <Text size="small" weight="plus" style={{ color: "var(--destructive, #B91C1C)" }}>
            Push failed
          </Text>
          <Text size="small" className="text-ui-fg-subtle" style={{ marginTop: 4 }}>
            {pushError}
          </Text>
          {pushErrorAt ? (
            <Text size="xsmall" className="text-ui-fg-muted" style={{ marginTop: 4 }}>
              Last attempt: {new Date(pushErrorAt).toLocaleString()}
            </Text>
          ) : null}
        </div>
      ) : null}

      {invoiceId && pushedAt ? (
        <div className="px-6 py-4">
          <Text size="xsmall" className="text-ui-fg-muted">
            Pushed {new Date(pushedAt).toLocaleString()}
          </Text>
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default OrderQboStatusWidget

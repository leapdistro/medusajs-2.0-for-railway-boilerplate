import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useRef, useState } from "react"

type OrderLite = {
  id: string
  display_id?: number | string
  metadata?: Record<string, any> | null
  fulfillments?: Array<{ id: string }> | null
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
      const res = await fetch(`/admin/orders/${data.id}?fields=id,display_id,metadata,fulfillments.id`, {
        credentials: "include",
        cache: "no-store",
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
  const fulfillmentsCount = order?.fulfillments?.length ?? 0

  /* ─── Auto-toast on QBO push completion ─────────────────────────────
   *
   * The fulfillment subscriber runs server-side after operator clicks
   * "Mark as Fulfilled" — the admin page itself gets no signal when
   * the QBO push lands. Two hooks below close that gap:
   *
   *   1. Polling effect: while order has fulfillments but no qbo state
   *      yet, refresh every 3s for up to 90s. Auto-stops on terminal
   *      state.
   *   2. Toast-on-transition effect: tracks the last-seen invoice id +
   *      error timestamp via refs; fires success / error toast when
   *      either crosses from unseen → seen. Dedupes against the
   *      manual "Push to QuickBooks" button (which already toasts in
   *      onPush) by capturing the toasted values in the same refs.
   */
  const lastToastedInvoiceRef = useRef<string | null | undefined>(undefined)
  const lastToastedErrorAtRef = useRef<string | null | undefined>(undefined)

  /* Capture initial state without toasting (so opening an
   * already-pushed order doesn't flash a stale toast on every visit),
   * then fire on subsequent transitions. */
  useEffect(() => {
    if (!order) return
    if (lastToastedInvoiceRef.current === undefined) {
      lastToastedInvoiceRef.current = invoiceId ?? null
      lastToastedErrorAtRef.current = pushErrorAt ?? null
      return
    }
    if (invoiceId && invoiceId !== lastToastedInvoiceRef.current) {
      toast.success("Pushed to QuickBooks", {
        description: paymentId
          ? `Invoice ${invoiceId} · paid`
          : `Invoice ${invoiceId}`,
      })
      lastToastedInvoiceRef.current = invoiceId
    } else if (pushErrorAt && pushErrorAt !== lastToastedErrorAtRef.current && !invoiceId) {
      toast.error("QuickBooks push failed", {
        description: pushError ?? "Check the order widget for details",
      })
      lastToastedErrorAtRef.current = pushErrorAt
    }
  }, [order, invoiceId, paymentId, pushError, pushErrorAt])

  /* Poll while order has fulfillments but no terminal QBO state.
   * Once invoiceId OR pushErrorAt appears, the polling effect re-runs
   * (deps change) and the early-return below stops the interval. */
  useEffect(() => {
    const waiting = fulfillmentsCount > 0 && !invoiceId && !pushErrorAt
    if (!waiting) return

    let elapsed = 0
    const interval = setInterval(() => {
      elapsed += 3000
      if (elapsed > 90_000) {
        clearInterval(interval)
        return
      }
      refresh()
    }, 3000)
    return () => clearInterval(interval)
  }, [fulfillmentsCount, invoiceId, pushErrorAt, refresh])

  const onPush = async (force = false) => {
    if (!order?.id) return
    setBusy(true)
    try {
      const url = `/admin/orders/${order.id}/push-to-qbo${force ? "?force=true" : ""}`
      const res = await fetch(url, { method: "POST", credentials: "include" })
      const json = await res.json()
      /* 409 ALREADY_PUSHED — offer to force re-push (e.g., operator
       * deleted the QBO invoice and wants a clean retry). */
      if (res.status === 409 && json?.code === "ALREADY_PUSHED") {
        const ok = window.confirm(
          `This order was already pushed (Invoice ${json.invoiceId}). Push a NEW invoice anyway? This will create a duplicate in QBO unless you deleted the old one first.`,
        )
        if (ok) {
          setBusy(false)
          return onPush(true)
        }
        toast("Already pushed — skipped")
        return
      }
      if (!res.ok) throw new Error(json?.error ?? json?.code ?? `Push failed (${res.status})`)
      toast.success("Pushed to QuickBooks", {
        description: json.paymentId
          ? `Invoice ${json.invoiceId} · paid`
          : `Invoice ${json.invoiceId}`,
      })
      /* Pre-stamp the toasted-invoice ref so the auto-toast effect
       * doesn't fire a second toast when refresh() lands the new
       * metadata in state. */
      lastToastedInvoiceRef.current = json.invoiceId
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
            onClick={() => onPush(false)}
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

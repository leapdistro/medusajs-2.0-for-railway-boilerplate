import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Input, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type OrderLite = {
  id: string
  display_id?: number
  status?: string
  email?: string
  metadata?: Record<string, any> | null
}

type SettingRow = { key: string; value: any }
type Reason = { id: string; label: string; archived?: boolean }

const CARRIERS = ["UPS", "FedEx", "USPS", "DHL", "Local Pickup", "Other"]

/**
 * Order detail widget — ship + cancel actions.
 *
 * Two collapsed sections:
 *   - Mark Shipped → form (carrier, tracking #, optional URL/ETA/note)
 *     → POST /admin/orders/:id/mark-shipped → stamps metadata + emails buyer
 *   - Cancel Order → form (reason from settings, operator note)
 *     → POST /admin/orders/:id/cancel-with-reason → cancelOrderWorkflow + email
 *
 * After shipping/cancelling, summary cards show what was sent and when.
 * Cancel hides itself if the order is already cancelled.
 */
const OrderShippingActionsWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const [order, setOrder] = useState<OrderLite | null>(data)
  const [reasons, setReasons] = useState<Reason[]>([])

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/orders/${data.id}?fields=id,display_id,status,email,metadata`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setOrder(json?.order ?? data)
    } catch {
      setOrder(data)
    }
  }, [data])

  const loadReasons = useCallback(async () => {
    try {
      const res = await fetch("/admin/mbs/settings", { credentials: "include" })
      if (!res.ok) return
      const json = await res.json()
      const row = (json?.settings ?? []).find((r: SettingRow) => r.key === "cancellation_reasons")
      const list = (Array.isArray(row?.value) ? row.value : []) as Reason[]
      setReasons(list.filter((r) => !r.archived))
    } catch {
      setReasons([])
    }
  }, [])

  useEffect(() => { refresh(); loadReasons() }, [refresh, loadReasons])

  const meta = order?.metadata ?? {}
  const isCancelled = order?.status === "canceled" || order?.status === "cancelled"
  const wasShipped  = !!meta.shipped_at

  return (
    <Container className="divide-y p-0">
      {!isCancelled && (
        <PaymentInstructionsSection orderId={data.id} meta={meta} onSent={refresh} />
      )}
      <ShipSection orderId={data.id} wasShipped={wasShipped} meta={meta} onSent={refresh} />
      {!isCancelled && (
        <CancelSection orderId={data.id} reasons={reasons} onSent={refresh} />
      )}
      {isCancelled && (
        <div className="px-6 py-4">
          <Heading level="h2">Cancelled</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            This order is cancelled
            {typeof meta.cancellation_reason_label === "string" && <> — <strong>{meta.cancellation_reason_label}</strong></>}.
          </Text>
        </div>
      )}
    </Container>
  )
}

/* ──────────── Payment Instructions section ──────────── */
const PaymentInstructionsSection = ({ orderId, meta, onSent }: { orderId: string; meta: any; onSent: () => void }) => {
  const [busy, setBusy] = useState(false)
  const sentAt = typeof meta.payment_instructions_sent_at === "string"
    ? new Date(meta.payment_instructions_sent_at)
    : null

  const submit = async () => {
    if (sentAt && !confirm("Payment instructions were already sent. Send again?")) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/send-payment-instructions`, {
        method: "POST",
        credentials: "include",
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        toast.error(json?.errors?.join(" | ") ?? json?.message ?? `Failed (${res.status})`)
        return
      }
      toast.success(sentAt ? "Payment instructions resent" : "Payment instructions sent")
      onSent()
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Heading level="h2">Payment instructions</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            For check / wire / Net Terms orders. Sends DBA + mailing address + bank info from MBS Settings → Payment Info.
          </Text>
          {sentAt && (
            <Text size="small" className="text-ui-fg-muted mt-1">
              Last sent: {sentAt.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
            </Text>
          )}
        </div>
        <Button
          variant={sentAt ? "secondary" : "primary"}
          onClick={submit}
          isLoading={busy}
        >
          {sentAt ? "Resend" : "Send Payment Instructions"}
        </Button>
      </div>
    </div>
  )
}

/* ─────────────────── Ship section ─────────────────── */
const ShipSection = ({ orderId, wasShipped, meta, onSent }: { orderId: string; wasShipped: boolean; meta: any; onSent: () => void }) => {
  const [open, setOpen] = useState(!wasShipped)
  const [carrier, setCarrier] = useState<string>(typeof meta.shipping_carrier === "string" ? meta.shipping_carrier : "UPS")
  const [tracking, setTracking] = useState<string>(typeof meta.shipping_tracking_number === "string" ? meta.shipping_tracking_number : "")
  const [trackingUrl, setTrackingUrl] = useState<string>(typeof meta.shipping_tracking_url === "string" ? meta.shipping_tracking_url : "")
  const [eta, setEta] = useState<string>(typeof meta.shipping_estimated_delivery === "string" ? meta.shipping_estimated_delivery : "")
  const [note, setNote] = useState<string>(typeof meta.shipping_operator_note === "string" ? meta.shipping_operator_note : "")
  const [busy, setBusy] = useState(false)

  const shippedAt = typeof meta.shipped_at === "string" ? new Date(meta.shipped_at) : null

  const submit = async () => {
    if (!carrier.trim() || !tracking.trim()) {
      toast.error("Carrier and tracking number are required")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/mark-shipped`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ carrier, trackingNumber: tracking, trackingUrl, estimatedDelivery: eta, operatorNote: note }),
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        toast.error(json?.message ?? `Failed (${res.status})`)
        return
      }
      toast.success(json.emailSent ? "Shipped — buyer notified" : `Shipped — ${json.message ?? "email skipped"}`)
      setOpen(false)
      onSent()
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Heading level="h2">Shipping</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {wasShipped
              ? "Tracking sent to the buyer. Re-send if anything changed."
              : "Add tracking + carrier when the order leaves the warehouse. Buyer gets a branded email with the tracking link."}
          </Text>
          {wasShipped && shippedAt && (
            <Text size="small" className="text-ui-fg-muted mt-1">
              Sent {shippedAt.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
              {typeof meta.shipping_carrier === "string" ? <> — {meta.shipping_carrier} {meta.shipping_tracking_number}</> : null}
            </Text>
          )}
        </div>
        {wasShipped && !open && (
          <Button variant="secondary" onClick={() => setOpen(true)}>Edit / Resend</Button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-3 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Text size="xsmall" weight="plus" className="mb-1.5 block">Carrier</Text>
              <Select value={carrier} onValueChange={setCarrier}>
                <Select.Trigger><Select.Value /></Select.Trigger>
                <Select.Content>
                  {CARRIERS.map((c) => <Select.Item key={c} value={c}>{c}</Select.Item>)}
                </Select.Content>
              </Select>
            </div>
            <div>
              <Text size="xsmall" weight="plus" className="mb-1.5 block">Tracking number</Text>
              <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z999AA10123456784" />
            </div>
          </div>
          <div>
            <Text size="xsmall" weight="plus" className="mb-1.5 block">Tracking URL (optional)</Text>
            <Input value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} placeholder="https://www.ups.com/track?…" />
          </div>
          <div>
            <Text size="xsmall" weight="plus" className="mb-1.5 block">Estimated delivery (optional)</Text>
            <Input value={eta} onChange={(e) => setEta(e.target.value)} placeholder="Tue, May 5" />
          </div>
          <div>
            <Text size="xsmall" weight="plus" className="mb-1.5 block">Note to buyer (optional)</Text>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Two boxes — 2 of 2 ships tomorrow." />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={submit} isLoading={busy}>
              {wasShipped ? "Resend Tracking" : "Mark Shipped & Notify"}
            </Button>
            {wasShipped && (
              <Button variant="transparent" onClick={() => setOpen(false)}>Cancel</Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────── Cancel section ─────────────────── */
const CancelSection = ({ orderId, reasons, onSent }: { orderId: string; reasons: Reason[]; onSent: () => void }) => {
  const [open, setOpen] = useState(false)
  const [reasonId, setReasonId] = useState<string>("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!reasonId) {
      toast.error("Pick a reason first")
      return
    }
    if (!confirm("Cancel this order? Inventory will be released and the buyer will be emailed. This can't be easily undone.")) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/orders/${orderId}/cancel-with-reason`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reasonId, operatorNote: note }),
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        toast.error(json?.message ?? `Failed (${res.status})`)
        return
      }
      toast.success(json.emailSent ? "Cancelled — buyer notified" : `Cancelled — ${json.message ?? "email skipped"}`)
      setOpen(false)
      onSent()
    } catch (e: any) {
      toast.error(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Heading level="h2">Cancel order</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Cancelling releases reserved inventory + emails the buyer with the reason.
          </Text>
        </div>
        {!open && (
          <Button variant="danger" onClick={() => setOpen(true)}>Cancel order…</Button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-3 mt-4">
          <div>
            <Text size="xsmall" weight="plus" className="mb-1.5 block">Reason</Text>
            {reasons.length === 0 ? (
              <Text size="small" className="text-ui-fg-error">
                No active reasons. Add some in MBS Settings → Cancellation Reasons.
              </Text>
            ) : (
              <Select value={reasonId} onValueChange={setReasonId}>
                <Select.Trigger><Select.Value placeholder="Pick a reason…" /></Select.Trigger>
                <Select.Content>
                  {reasons.map((r) => (
                    <Select.Item key={r.id} value={r.id}>{r.label}</Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
          </div>
          <div>
            <Text size="xsmall" weight="plus" className="mb-1.5 block">Note to buyer (optional)</Text>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sorry — that strain unexpectedly sold out before we could ship." />
          </div>
          <div className="flex gap-2">
            <Button variant="danger" onClick={submit} isLoading={busy} disabled={!reasonId || reasons.length === 0}>
              Cancel Order & Notify
            </Button>
            <Button variant="transparent" onClick={() => setOpen(false)}>Back</Button>
          </div>
        </div>
      )}
    </div>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.before",
})

export default OrderShippingActionsWidget

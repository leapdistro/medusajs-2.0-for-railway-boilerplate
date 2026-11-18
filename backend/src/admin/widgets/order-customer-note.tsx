import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"

type OrderLite = { id: string; metadata?: Record<string, any> | null }

/**
 * Order detail widget — the note the buyer left at checkout, in amber at
 * the top of the order so it's seen before packing.
 *
 * The storefront saves it on the cart (`metadata.order_note`) just before
 * the cart completes, and Medusa copies cart metadata onto the order.
 * Hidden when the order has no note.
 */
const OrderCustomerNoteWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const [metadata, setMetadata] = useState<Record<string, any> | null | undefined>(data?.metadata)
  useEffect(() => { setMetadata(data?.metadata) }, [data?.metadata])

  /* Backstop in case the page's order payload didn't include metadata. */
  useEffect(() => {
    if (!data?.id || data.metadata !== undefined) return
    let cancelled = false
    fetch(`/admin/orders/${data.id}?fields=id,metadata`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setMetadata(j?.order?.metadata ?? null) })
      .catch(() => { /* no note shown */ })
    return () => { cancelled = true }
  }, [data?.id, data?.metadata])

  const note = typeof metadata?.order_note === "string" ? metadata.order_note.trim() : ""
  if (!note) return null

  return (
    <Container
      className="p-0 overflow-hidden"
      style={{
        background: "rgba(245, 158, 11, 0.14)",
        border: "1px solid rgba(217, 119, 6, 0.55)",
        borderLeft: "6px solid #D97706",
      }}
    >
      <div className="px-6 py-4">
        <Heading level="h2" style={{ color: "#B45309" }}>Customer note</Heading>
        <Text
          size="small"
          className="text-ui-fg-base mt-2"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {note}
        </Text>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.before",
})

export default OrderCustomerNoteWidget

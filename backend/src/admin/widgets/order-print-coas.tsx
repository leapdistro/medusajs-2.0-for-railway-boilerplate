import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text } from "@medusajs/ui"

type OrderLite = { id: string; display_id?: number | null }

/**
 * Order detail widget — Print All COAs and Print Packing Slip buttons.
 *
 * Packing slip: /admin/orders/:id/packing-slip, a print-ready page with
 * each item's size, category, tier and quantity (no prices). It opens
 * the print dialog by itself.
 *
 * Opens /admin/orders/:id/coas-bundle in a new tab. The route streams
 * a combined PDF of every unique product's COA from the order (dedup
 * by handle, line-item order, missing-COA silently skipped, image
 * COAs auto-converted to single-page PDFs).
 *
 * The operator hits Cmd-P / Ctrl-P in the new tab to print the
 * stack, or saves the PDF for emailing.
 *
 * Same artifact a buyer would get from /api/account/orders/:id/coas-bundle
 * on the storefront — they share the lib/coa-bundle.ts helper.
 */
const OrderPrintCoasWidget = ({ data }: DetailWidgetProps<OrderLite>) => {
  const orderId = data?.id
  const displayId = data?.display_id

  if (!orderId) return null

  const href = `/admin/orders/${orderId}/coas-bundle`
  const slipHref = `/admin/orders/${orderId}/packing-slip`
  const label = displayId != null ? `Order #${displayId}` : "this order"

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4 flex items-center justify-between gap-4">
        <div>
          <Heading level="h2">Print</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            COAs: combined PDF of every unique product&rsquo;s lab report from {label} — Cmd-P / Ctrl-P to print.
            Packing slip: items, size, category, tier and quantity, no prices.
          </Text>
        </div>
        <div className="flex shrink-0 gap-2">
          <a href={slipHref} target="_blank" rel="noopener noreferrer">
            <Button variant="secondary">Print Packing Slip</Button>
          </a>
          <a href={href} target="_blank" rel="noopener noreferrer">
            <Button variant="primary">Print All COAs</Button>
          </a>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.before",
})

export default OrderPrintCoasWidget

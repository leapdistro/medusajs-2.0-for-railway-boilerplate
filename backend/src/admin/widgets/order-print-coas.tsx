import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text } from "@medusajs/ui"

type OrderLite = { id: string; display_id?: number | null }

/**
 * Order detail widget — Print Invoice, Print Packing Slip and Print All
 * COAs buttons.
 *
 * Invoice: /admin/orders/:id/invoice redirects to the buyer's own invoice
 * PDF on the storefront with a 30-minute signed link (see that route).
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
  const invoiceHref = `/admin/orders/${orderId}/invoice`
  const label = displayId != null ? `Order #${displayId}` : "this order"

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div style={{ flex: "1 1 240px" }}>
          <Heading level="h2">Print</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Invoice, packing slip and lab reports for {label}.
          </Text>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={invoiceHref} target="_blank" rel="noopener noreferrer">
            <Button variant="secondary">Print Invoice</Button>
          </a>
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

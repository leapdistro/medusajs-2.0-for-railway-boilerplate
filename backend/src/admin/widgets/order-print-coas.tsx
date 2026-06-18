import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text } from "@medusajs/ui"

type OrderLite = { id: string; display_id?: number | null }

/**
 * Order detail widget — Print All COAs button.
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
  const label = displayId != null ? `Order #${displayId}` : "this order"

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4 flex items-center justify-between gap-4">
        <div>
          <Heading level="h2">COAs</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Combined PDF of every unique product&rsquo;s lab report from {label}.
            Opens in a new tab — Cmd-P / Ctrl-P to send to printer.
          </Text>
        </div>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ flexShrink: 0 }}
        >
          <Button variant="primary">Print All COAs</Button>
        </a>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.before",
})

export default OrderPrintCoasWidget

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text } from "@medusajs/ui"

type CustomerLite = {
  id: string
  metadata?: Record<string, any> | null
}

type DocKind = "image" | "pdf" | "other"

const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"] as const

function classifyDoc(url: string): DocKind {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
  if (ext === "pdf") return "pdf"
  if (IMAGE_EXTS.includes(ext as (typeof IMAGE_EXTS)[number])) return "image"
  return "other"
}

function filenameFromUrl(url: string): string {
  const path = url.split("?")[0]
  return decodeURIComponent(path.split("/").pop() ?? "document")
}

/**
 * Renders a single uploaded document as a card with inline preview
 * (image) or PDF icon, plus a "View" button that opens it in a new tab.
 * Saves the operator a copy-paste-into-address-bar round trip.
 */
const DocCard = ({ label, url }: { label: string; url: string }) => {
  const kind = classifyDoc(url)
  const filename = filenameFromUrl(url)

  return (
    <div className="border-ui-border-base flex flex-col gap-3 border p-4">
      <Text size="xsmall" weight="plus" className="text-ui-fg-subtle uppercase tracking-wide">
        {label}
      </Text>
      <div className="bg-ui-bg-subtle flex h-40 items-center justify-center overflow-hidden">
        {kind === "image" ? (
          <img
            src={url}
            alt={`${label} preview`}
            className="h-full w-full object-contain"
          />
        ) : kind === "pdf" ? (
          <div className="flex flex-col items-center gap-2">
            <div className="border-ui-border-base flex h-16 w-12 items-center justify-center border">
              <Text size="xsmall" weight="plus" className="text-ui-fg-subtle">PDF</Text>
            </div>
            <Text size="xsmall" className="text-ui-fg-muted">PDF document</Text>
          </div>
        ) : (
          <Text size="xsmall" className="text-ui-fg-muted">No inline preview</Text>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Text size="xsmall" className="text-ui-fg-muted truncate" title={filename}>
          {filename}
        </Text>
        <a href={url} target="_blank" rel="noopener noreferrer">
          <Button variant="secondary" size="small">View</Button>
        </a>
      </div>
    </div>
  )
}

const CustomerApplicationDocsWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const meta = data?.metadata ?? {}
  const einUrl = typeof meta.ein_doc_url === "string" ? meta.ein_doc_url : ""
  const licenseUrl = typeof meta.license_doc_url === "string" ? meta.license_doc_url : ""

  /* Hide entirely for customers without uploaded application docs —
   * keeps the page clean for non-application customers (manually-created,
   * legacy, etc.). */
  if (!einUrl && !licenseUrl) return null

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Application Documents</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Files uploaded during this customer's wholesale application.
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        {einUrl && <DocCard label="EIN Document" url={einUrl} />}
        {licenseUrl && <DocCard label="Resale Certificate" url={licenseUrl} />}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerApplicationDocsWidget

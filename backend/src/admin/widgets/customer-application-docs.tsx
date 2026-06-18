import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Select, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type CustomerLite = {
  id: string
  metadata?: Record<string, any> | null
}

type BusinessTypeOption = { id: string; label: string }

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

  /* Live state for the business type dropdown. Seeded from the
   * customer's stamped metadata, mutated locally on Select change so
   * the dropdown feels snappy, then synced to the backend route. */
  const initialId = typeof meta.business_type === "string" ? meta.business_type : ""
  const initialLabel = typeof meta.business_type_label === "string" ? meta.business_type_label : ""
  const [currentId, setCurrentId] = useState<string>(initialId)
  const [currentLabel, setCurrentLabel] = useState<string>(initialLabel)
  const [options, setOptions] = useState<BusinessTypeOption[]>([])
  const [saving, setSaving] = useState(false)

  /* Load options from the public store route — same payload the apply
   * form's dropdown uses, archived entries filtered server-side. */
  useEffect(() => {
    let cancelled = false
    fetch("/store/mbs/business-types", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { business_types?: BusinessTypeOption[] }) => {
        if (cancelled) return
        setOptions(j.business_types ?? [])
      })
      .catch(() => {
        /* Soft-fail — operator just sees the current label as
         * read-only fallback. Bell isn't worth blocking page render. */
      })
    return () => { cancelled = true }
  }, [])

  /* Hide entirely for customers without uploaded application docs —
   * keeps the page clean for non-application customers. */
  if (!einUrl && !licenseUrl) return null

  const onPick = async (nextId: string) => {
    if (!data?.id) return
    const prevId = currentId
    const prevLabel = currentLabel
    /* Optimistic — show the new value immediately, roll back on error. */
    const optimisticLabel = options.find((o) => o.id === nextId)?.label ?? currentLabel
    setCurrentId(nextId)
    setCurrentLabel(optimisticLabel)
    setSaving(true)
    try {
      const res = await fetch(`/admin/customers/${data.id}/business-type`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: nextId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      setCurrentLabel(json.business_type_label ?? optimisticLabel)
      toast.success(`Business type → ${json.business_type_label ?? "—"}`)
    } catch (e: any) {
      /* Roll back on failure. */
      setCurrentId(prevId)
      setCurrentLabel(prevLabel)
      toast.error(`Update failed: ${e?.message ?? "unknown"}`)
    } finally {
      setSaving(false)
    }
  }

  /* If the customer's current type is no longer in the live options
   * list (operator archived it after this customer was set), surface
   * it as a placeholder option so the dropdown still renders the
   * current value with a clear "(archived)" suffix. */
  const currentInOptions = currentId && options.some((o) => o.id === currentId)
  const renderOptions: BusinessTypeOption[] = currentInOptions || !currentId
    ? options
    : [...options, { id: currentId, label: `${currentLabel || currentId} (archived)` }]

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Application Documents</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Files uploaded during this customer's wholesale application.
        </Text>
      </div>
      <div className="flex items-center gap-3 px-6 py-3">
        <Text size="xsmall" weight="plus" className="text-ui-fg-subtle uppercase tracking-wide" style={{ minWidth: 110 }}>
          Business Type
        </Text>
        <div style={{ minWidth: 240, maxWidth: 360, flex: 1 }}>
          <Select value={currentId} onValueChange={onPick} disabled={saving}>
            <Select.Trigger>
              <Select.Value placeholder="— Pick a business type —" />
            </Select.Trigger>
            <Select.Content>
              {renderOptions.map((o) => (
                <Select.Item key={o.id} value={o.id}>{o.label}</Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
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

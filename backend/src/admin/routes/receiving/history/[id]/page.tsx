import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * Receiving history detail — full breakdown of one receiving record.
 * Shows the supplier card, invoice meta, totals (printed + computed),
 * and the per-line outcome table from saveOneRow's results.
 *
 * Links to each created/restocked product so the operator can jump
 * straight into the catalog to verify pricing/inventory.
 */

type LineResult = {
  strainName: string
  action: "created" | "restocked" | "failed"
  productId?: string
  productHandle?: string
  inventoryItemId?: string
  qtyQps: number
  landedPerQp: number
  sellPrices: { qp: number; half: number; lb: number } | null
  error?: string
}

type Record = {
  id: string
  invoice_number: string
  invoice_date: string
  supplier: { name?: string; phone?: string | null; email?: string | null; address?: string | null }
  shipping_total: string
  invoice_total: string
  total_qps: number
  line_results: LineResult[]
  notes: string | null
  created_at: string
  updated_at: string
}

const ReceivingHistoryDetailPage = () => {
  /* No useParams in admin SDK routes — pull id from window.location. */
  const id = typeof window !== "undefined"
    ? window.location.pathname.split("/").filter(Boolean).pop()
    : null

  const [record, setRecord] = useState<Record | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    fetch(`/admin/receiving/history/${id}`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (j.record) setRecord(j.record)
        else setError(j?.message ?? "Not found")
        setLoading(false)
      })
      .catch((e) => { setError(e?.message ?? "Network error"); setLoading(false) })
  }, [id])

  if (loading) return <Container className="p-6"><Text>Loading…</Text></Container>
  if (error || !record) {
    return <Container className="p-6">
      <Text style={{ color: "#B91C1C" }}>{error ?? "Not found"}</Text>
      <Button asChild variant="secondary" className="mt-4"><a href="/app/receiving/history">← Back</a></Button>
    </Container>
  }

  const lines = record.line_results ?? []
  const created = lines.filter((l) => l.action === "created").length
  const restocked = lines.filter((l) => l.action === "restocked").length
  const failed = lines.filter((l) => l.action === "failed").length
  const totalLineCost = lines.reduce((s, l) => s + (l.qtyQps * l.landedPerQp), 0)

  return (
    <Container className="flex flex-col gap-6 p-6">
      <div className="flex justify-between items-center">
        <div className="flex flex-col">
          <Button asChild variant="transparent" size="small" className="self-start mb-2">
            <a href="/app/receiving/history">← All Receivings</a>
          </Button>
          <Heading level="h1">{record.invoice_number}</Heading>
          <Text className="text-ui-fg-subtle">{record.supplier?.name ?? "Unknown supplier"} · {record.invoice_date}</Text>
        </div>
        <div className="flex gap-2">
          {failed === 0
            ? <Badge color="green">{created} created · {restocked} restocked</Badge>
            : <Badge color="orange">{failed} failed</Badge>}
        </div>
      </div>

      {/* Supplier + invoice */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Supplier</Text>
          <Text size="base" weight="plus">{record.supplier?.name ?? "—"}</Text>
          {record.supplier?.phone && <Text size="small">{record.supplier.phone}</Text>}
          {record.supplier?.email && <Text size="small">{record.supplier.email}</Text>}
          {record.supplier?.address && <Text size="small" className="text-ui-fg-subtle">{record.supplier.address}</Text>}
        </div>
        <div style={{ border: "1.5px solid #E5E1D6", padding: 16 }}>
          <Text size="small" weight="plus" style={{ textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Invoice</Text>
          <div style={{ fontFamily: "monospace", fontSize: 13 }}>
            <Row label="Number"        value={record.invoice_number} />
            <Row label="Date"          value={record.invoice_date} />
            <Row label="Shipping"      value={`$${Number(record.shipping_total).toFixed(2)}`} />
            <Row label="Invoice total" value={`$${Number(record.invoice_total).toFixed(2)}`} />
            <Row label="Total QPs"     value={String(record.total_qps)} />
            <Row label="Σ landed cost" value={`$${totalLineCost.toFixed(2)}`} />
            <Row label="Saved"         value={new Date(record.created_at).toLocaleString()} />
          </div>
        </div>
      </div>

      {record.notes && (
        <div style={{ border: "1.5px solid #C98A00", padding: "10px 14px", background: "#fff" }}>
          <Text size="small" weight="plus" style={{ color: "#C98A00", textTransform: "uppercase", letterSpacing: "0.1em" }}>Notes</Text>
          <Text size="small">{record.notes}</Text>
        </div>
      )}

      {/* Line items */}
      <div style={{ border: "1.5px solid #E5E1D6", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F3F1EA", borderBottom: "1.5px solid #0A0A0A" }}>
              <Th>Strain</Th>
              <Th>Action</Th>
              <Th align="right">QPs</Th>
              <Th align="right">Landed / QP</Th>
              <Th align="right">Line Cost</Th>
              <Th align="right">Sell QP / Half / LB</Th>
              <Th>Product</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const lineCost = l.qtyQps * l.landedPerQp
              return (
                <tr key={i} style={{
                  borderBottom: "1px solid #E5E1D6",
                  background: l.action === "failed" ? "rgba(185,28,28,0.05)" : undefined,
                }}>
                  <Td>{l.strainName}</Td>
                  <Td>
                    {l.action === "created"   && <Badge color="green">created</Badge>}
                    {l.action === "restocked" && <Badge color="blue">restocked</Badge>}
                    {l.action === "failed"    && <Badge color="red" title={l.error}>failed</Badge>}
                  </Td>
                  <Td align="right" style={{ fontFamily: "monospace" }}>{l.qtyQps}</Td>
                  <Td align="right" style={{ fontFamily: "monospace" }}>${l.landedPerQp.toFixed(2)}</Td>
                  <Td align="right" style={{ fontFamily: "monospace" }}>${lineCost.toFixed(2)}</Td>
                  <Td align="right" style={{ fontFamily: "monospace" }}>
                    {l.sellPrices
                      ? `$${l.sellPrices.qp} / $${l.sellPrices.half} / $${l.sellPrices.lb}`
                      : <span style={{ color: "#888" }}>—</span>}
                  </Td>
                  <Td>
                    {l.productId
                      ? <a href={`/app/products/${l.productId}`}
                          style={{ color: "#0A0A0A", textDecoration: "underline", fontFamily: "monospace", fontSize: 12 }}>
                          {l.productHandle ?? "open"}
                        </a>
                      : l.error
                        ? <Text size="small" style={{ color: "#B91C1C" }}>{l.error}</Text>
                        : "—"}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Container>
  )
}

const Th: React.FC<{ children?: React.ReactNode; align?: "left" | "right" }> = ({ children, align = "left" }) => (
  <th style={{ padding: "10px 12px", textAlign: align, fontFamily: "monospace", fontSize: 10, fontWeight: 600, letterSpacing: "0.15em", textTransform: "uppercase" }}>
    {children}
  </th>
)
const Td: React.FC<{ children?: React.ReactNode; align?: "left" | "right"; style?: React.CSSProperties }> = ({ children, align = "left", style }) => (
  <td style={{ padding: "10px 12px", textAlign: align, verticalAlign: "middle", ...style }}>{children}</td>
)
const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
    <span style={{ color: "#888" }}>{label}</span>
    <span>{value}</span>
  </div>
)

export default ReceivingHistoryDetailPage

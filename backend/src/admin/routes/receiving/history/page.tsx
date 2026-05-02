import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * Receiving history — list view. Renders every receiving_record so
 * the operator can audit what was received, when, by whom (supplier),
 * for how much, and how each line landed (created vs restocked vs
 * failed). Sorted newest first.
 *
 * Click a row → detail page with full line-by-line breakdown.
 */

const TruckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7V8z" />
    <circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
)

type Record = {
  id: string
  invoice_number: string
  invoice_date: string
  supplier: { name?: string; phone?: string | null; email?: string | null; address?: string | null }
  shipping_total: string
  invoice_total: string
  total_qps: number
  line_results: Array<{ action: "created" | "restocked" | "failed"; strainName: string; error?: string }>
  notes: string | null
  created_at: string
}

const ReceivingHistoryPage = () => {
  const [records, setRecords] = useState<Record[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/admin/receiving/history", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => { setRecords(j.records ?? []); setLoading(false) })
      .catch((e) => { setError(e?.message ?? "Network error"); setLoading(false) })
  }, [])

  return (
    <Container className="flex flex-col gap-6 p-6">
      <div className="flex justify-between items-center">
        <Heading level="h1">Receiving History</Heading>
        <Button variant="primary" asChild>
          <a href="/app/receiving">+ New Receiving</a>
        </Button>
      </div>

      {loading && <Text className="text-ui-fg-subtle">Loading…</Text>}
      {error && <Text style={{ color: "#B91C1C" }}>{error}</Text>}

      {!loading && !error && records.length === 0 && (
        <div style={{ border: "1px dashed #C9C3B2", padding: 32, textAlign: "center" }}>
          <Text size="large" weight="plus">No receivings yet</Text>
          <Text size="small" className="text-ui-fg-subtle">Click + New Receiving to upload your first invoice.</Text>
        </div>
      )}

      {records.length > 0 && (
        <div style={{ border: "1.5px solid #E5E1D6", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F3F1EA", borderBottom: "1.5px solid #0A0A0A" }}>
                <Th>Date</Th>
                <Th>Supplier</Th>
                <Th>Invoice #</Th>
                <Th align="right">Lines</Th>
                <Th align="right">QPs</Th>
                <Th align="right">Invoice Total</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const lines = r.line_results ?? []
                const created = lines.filter((l) => l.action === "created").length
                const restocked = lines.filter((l) => l.action === "restocked").length
                const failed = lines.filter((l) => l.action === "failed").length
                const status = failed === 0
                  ? <Badge color="green">{created} created · {restocked} restocked</Badge>
                  : <Badge color="orange">{failed} failed</Badge>
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid #E5E1D6" }}>
                    <Td style={{ fontFamily: "monospace" }}>{r.invoice_date}</Td>
                    <Td>{r.supplier?.name ?? "—"}</Td>
                    <Td style={{ fontFamily: "monospace" }}>{r.invoice_number}</Td>
                    <Td align="right">{lines.length}</Td>
                    <Td align="right" style={{ fontFamily: "monospace" }}>{r.total_qps}</Td>
                    <Td align="right" style={{ fontFamily: "monospace" }}>${Number(r.invoice_total).toLocaleString()}</Td>
                    <Td>{status}</Td>
                    <Td>
                      <a href={`/app/receiving/history/${r.id}`}
                        style={{ color: "#0A0A0A", textDecoration: "underline", fontFamily: "monospace", fontSize: 12 }}>
                        View →
                      </a>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
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

export const config = defineRouteConfig({
  label: "Receiving History",
  icon: TruckIcon,
})

export default ReceivingHistoryPage

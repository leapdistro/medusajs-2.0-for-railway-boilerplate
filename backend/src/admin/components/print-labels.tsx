import { Button, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * Shelf labels from the receiving screens: one Print button per received
 * line, for the label format named like the line's stock unit (a QP line
 * prints the QP label). Only products whose category prints labels get a
 * button; the backend decides (GET /admin/mbs/labels/print-link).
 *
 * The button opens the storefront's label page through a short-lived
 * admin link, so it prints the same label buyers print. The print dialog
 * sets how many copies.
 */

export type LabelLine = {
  strainName: string
  tierLabel?: string
  action: string
  productId?: string
  poolUnitLabel?: string
  qtyQps: number
}

type Printable = { format: { id: string; label: string } | null; printable: Record<string, boolean> }

/** Which lines can print, for the stock unit of these lines. */
export function usePrintable(lines: LabelLine[]): Printable | null {
  const unit = lines.find((l) => l.poolUnitLabel)?.poolUnitLabel ?? ""
  const ids = [...new Set(lines.filter((l) => l.productId && (l.action === "created" || l.action === "restocked")).map((l) => l.productId!))]
  const key = `${unit}|${ids.join(",")}`
  const [state, setState] = useState<{ key: string; data: Printable } | null>(null)
  useEffect(() => {
    if (!unit || !ids.length) return
    let live = true
    fetch(`/admin/mbs/labels/print-link?${new URLSearchParams({ unit, productIds: ids.join(",") })}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live && data) setState({ key, data }) })
      .catch(() => {})
    return () => { live = false }
  }, [key])
  return state?.key === key ? state.data : null
}

export function PrintLabelButton({ productId, unit, formatLabel, qty }: {
  productId: string
  unit: string
  formatLabel: string
  qty: number
}) {
  const [busy, setBusy] = useState(false)
  const print = async () => {
    /* Open the tab now, while the click still counts as the user's:
     * a window opened after the await is caught by popup blockers. */
    const w = window.open("", "_blank")
    setBusy(true)
    try {
      const r = await fetch("/admin/mbs/labels/print-link", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, unit }),
      })
      const json = await r.json().catch(() => ({}))
      if (!r.ok || !json.url) throw new Error(json.error ?? `Couldn't make the label link (${r.status})`)
      if (w) w.location.href = json.url
      else window.location.href = json.url
    } catch (e: any) {
      w?.close()
      toast.error(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant="secondary"
      size="small"
      isLoading={busy}
      onClick={print}
      title={qty > 1 ? `Set Copies to ${qty} in the print dialog for one label per ${formatLabel}` : undefined}
    >
      Print {formatLabel} label
    </Button>
  )
}

/** The Saved screen's list: received lines that print labels. */
export function ReceivedLabels({ historyId }: { historyId: string }) {
  const [lines, setLines] = useState<LabelLine[]>([])
  useEffect(() => {
    let live = true
    fetch(`/admin/receiving/history/${historyId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (live) setLines(json?.record?.line_results ?? json?.line_results ?? []) })
      .catch(() => {})
    return () => { live = false }
  }, [historyId])
  const printable = usePrintable(lines)
  const rows = lines.filter((l) => l.productId && printable?.printable[l.productId])
  if (!printable?.format || !rows.length) return null
  const fmt = printable.format
  const cell = { padding: "8px 10px", borderTop: "1px solid #E5E1D6", fontSize: 13, verticalAlign: "middle" as const }

  return (
    <div style={{ marginTop: 20 }}>
      <Text size="small" weight="plus">Print labels</Text>
      <Text size="small" className="text-ui-fg-subtle">
        One {fmt.label} label per line. For more than one, set Copies in the print dialog.
      </Text>
      <table style={{ borderCollapse: "collapse", marginTop: 8, minWidth: 420 }}>
        <tbody>
          {rows.map((l, i) => (
            <tr key={`${l.productId}-${i}`}>
              <td style={cell}>{l.strainName}{l.tierLabel ? <span className="text-ui-fg-muted"> · {l.tierLabel}</span> : null}</td>
              <td style={{ ...cell, fontFamily: "monospace", whiteSpace: "nowrap" }}>{l.qtyQps} {l.poolUnitLabel}</td>
              <td style={{ ...cell, textAlign: "right" }}>
                <PrintLabelButton productId={l.productId!} unit={l.poolUnitLabel!} formatLabel={fmt.label} qty={l.qtyQps} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

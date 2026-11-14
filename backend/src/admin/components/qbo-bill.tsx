import { Badge, Button, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * A receiving's QuickBooks Bill, for the Saved screens and Receiving
 * History: "Push to QuickBooks" when it has none, "Add N lines to Bill X"
 * when lines were saved under the same invoice after the Bill was pushed
 * (they carry no `qboBillId`), else "Pushed · Bill X".
 *
 * Reads the receiving record itself, so it's right whichever screen
 * shows it. Same rule as the backend's `unbilledLines`: a receiving
 * pushed before lines were stamped counts as fully on its Bill.
 */

type Line = { action: string; qtyQps: number; landedPerQp: number; qboBillId?: string; strainName: string }
type Rec = { id: string; qbo_bill_id: string | null; qbo_pushed_at?: string | null; line_results?: Line[] }

const usable = (r: Rec) => (r.line_results ?? []).filter((l) => l.action !== "failed" && l.qtyQps > 0 && l.landedPerQp > 0)

export function unbilledOf(r: Rec | null): Line[] {
  if (!r?.qbo_bill_id) return []
  const lines = usable(r)
  if (!lines.some((l) => l.qboBillId)) return []
  return lines.filter((l) => l.qboBillId !== String(r.qbo_bill_id))
}

export function QboBill({ historyId, size = "base", onChange }: {
  historyId: string
  size?: "small" | "base"
  /** After a push or an add, e.g. so a page reloads its record. */
  onChange?: () => void
}) {
  const [rec, setRec] = useState<Rec | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () =>
    fetch(`/admin/receiving/history/${historyId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setRec(j?.record ?? null))
      .catch(() => {})
  useEffect(() => { load() }, [historyId])

  if (!rec) return null
  const unbilled = unbilledOf(rec)
  const amount = unbilled.reduce((s, l) => s + l.qtyQps * l.landedPerQp, 0)

  const push = async (append: boolean) => {
    setBusy(true)
    try {
      const res = await fetch("/admin/qbo/push-bill", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId, ...(append ? { append: true } : {}) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error ?? `Push failed (${res.status})`)
      toast.success(append ? `Added to Bill ${json.billId}` : "Pushed to QuickBooks", {
        description: append
          ? `${json.added} line(s)${json.billTotal != null ? ` · Bill total $${Number(json.billTotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : ""}`
          : `Bill ${json.billId} · ${json.lines} line(s)`,
      })
      await load()
      onChange?.()
    } catch (e: any) {
      toast.error(append ? "Couldn't add to the Bill" : "Push failed", { description: e?.message ?? "Network error" })
    } finally {
      setBusy(false)
    }
  }

  if (!rec.qbo_bill_id) {
    return <Button variant="primary" size={size} isLoading={busy} onClick={() => push(false)}>Push to QuickBooks</Button>
  }
  if (unbilled.length > 0) {
    return (
      <>
        <Badge color="orange" title={unbilled.map((l) => l.strainName).join(", ")}>
          {unbilled.length} line{unbilled.length === 1 ? "" : "s"} not in QuickBooks · ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Badge>
        <Button variant="primary" size={size} isLoading={busy} onClick={() => push(true)}>
          Add {unbilled.length} line{unbilled.length === 1 ? "" : "s"} to Bill {rec.qbo_bill_id}
        </Button>
      </>
    )
  }
  return (
    <Badge color="purple" title={rec.qbo_pushed_at ? `Pushed ${rec.qbo_pushed_at}` : undefined}>
      ✓ Pushed to QBO · Bill {rec.qbo_bill_id}
    </Badge>
  )
}

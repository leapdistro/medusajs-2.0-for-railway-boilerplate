import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { clx } from "@medusajs/ui"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

type Cell = { el: HTMLElement; orderId: string }
type Qbo = { label: string; color: "green" | "red" | "orange" | "grey"; title?: string }

/** The same reading of order metadata as the order page's QuickBooks panel. */
function qboState(meta: Record<string, any> | null | undefined): Qbo {
  const m = meta ?? {}
  if (m.qbo_invoice_id) {
    if (m.qbo_sync_error) return { label: "Sync failed", color: "orange", title: String(m.qbo_sync_error) }
    if (m.qbo_sync_action === "voided") return { label: "Voided", color: "grey", title: m.qbo_sync_message }
    return { label: "Pushed", color: "green", title: `Invoice ${m.qbo_invoice_id}` }
  }
  if (m.qbo_push_error) return { label: "Push failed", color: "red", title: String(m.qbo_push_error) }
  return { label: "Not pushed", color: "grey" }
}

/** Matches Medusa's own status cell (dot + label) so the column reads like Fulfillment. */
const QboCell = ({ q, onOpen }: { q?: Qbo; onOpen: () => void }) => (
  <div className="flex size-full cursor-pointer items-center pe-6" onClick={onOpen} title={q?.title}>
    <div className="txt-compact-small text-ui-fg-subtle flex h-full w-full items-center gap-x-2 overflow-hidden">
      {q ? (
        <>
          <div role="presentation" className="flex h-5 w-2 items-center justify-center">
            <div
              className={clx("h-2 w-2 rounded-sm shadow-[0px_0px_0px_1px_rgba(0,0,0,0.12)_inset]", {
                "bg-ui-tag-neutral-icon": q.color === "grey",
                "bg-ui-tag-green-icon": q.color === "green",
                "bg-ui-tag-red-icon": q.color === "red",
                "bg-ui-tag-orange-icon": q.color === "orange",
              })}
            />
          </div>
          <span className="truncate">{q.label}</span>
        </>
      ) : (
        <span className="text-ui-fg-muted">–</span>
      )}
    </div>
  </div>
)

/**
 * Orders list → a "QuickBooks" column right after Fulfillment (owner,
 * 2026-11-09). Medusa's order table takes no extra columns, so this
 * widget adds a header cell and one cell per row to the rendered table
 * and fills them through portals. Rows are matched to orders by their
 * row link, which also covers rows React reuses on the next page.
 * Renders nothing in the widget zone itself.
 */
const OrdersQboColumn = () => {
  const [cells, setCells] = useState<Cell[]>([])
  const [states, setStates] = useState<Record<string, Qbo>>({})

  useEffect(() => {
    let frame = 0
    const sync = () => {
      frame = 0
      const th = document.querySelector<HTMLElement>('th[data-table-header-id="fulfillment_status"]')
      const row = th?.parentElement
      const table = th?.closest("table")
      if (!th || !row || !table) {
        setCells((prev) => (prev.length ? [] : prev))
        return
      }
      if ((th.nextElementSibling as HTMLElement | null)?.dataset.mbsQbo !== "head") {
        const head = document.createElement("th")
        head.className = th.className
        head.setAttribute("style", th.getAttribute("style") ?? "")
        head.dataset.mbsQbo = "head"
        head.innerHTML = '<div class="flex h-full w-full items-center"><span class="truncate">QuickBooks</span></div>'
        th.after(head)
      }
      const own = (n: Element) => !(n as HTMLElement).dataset.mbsQbo
      const col = Array.from(row.children).filter(own).indexOf(th)

      const next: Cell[] = []
      table.querySelectorAll("tbody > tr").forEach((tr) => {
        const fulfillment = Array.from(tr.children).filter(own)[col] as HTMLElement | undefined
        const href = tr.querySelector("a[data-row-link]")?.getAttribute("href") ?? ""
        const orderId = href.match(/\/orders\/([^/?#]+)/)?.[1]
        if (!fulfillment || !orderId) return
        let td = fulfillment.nextElementSibling as HTMLElement | null
        if (td?.dataset.mbsQbo !== "cell") {
          td = document.createElement("td")
          td.className = fulfillment.className
          td.dataset.mbsQbo = "cell"
          fulfillment.after(td)
        }
        next.push({ el: td, orderId })
      })
      setCells((prev) =>
        prev.length === next.length && prev.every((c, i) => c.el === next[i].el && c.orderId === next[i].orderId) ? prev : next,
      )
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      document.querySelectorAll("[data-mbs-qbo]").forEach((n) => n.remove())
    }
  }, [])

  /* Fresh status for the orders on screen, whenever that set changes. */
  const idsKey = Array.from(new Set(cells.map((c) => c.orderId))).sort().join(",")
  const seq = useRef(0)
  useEffect(() => {
    if (!idsKey) return
    const ids = idsKey.split(",")
    const mine = ++seq.current
    const qs = new URLSearchParams({ fields: "id,metadata", limit: String(ids.length) })
    ids.forEach((id) => qs.append("id[]", id))
    fetch(`/admin/orders?${qs}`, { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (mine !== seq.current) return
        const found: Record<string, Qbo> = {}
        for (const o of json?.orders ?? []) found[o.id] = qboState(o.metadata)
        setStates((prev) => ({ ...prev, ...found }))
      })
      .catch(() => { /* cells keep their dash */ })
  }, [idsKey])

  /* A click in the new cell opens the order, like every other cell in the row. */
  const open = (el: HTMLElement) => el.closest("tr")?.querySelector<HTMLElement>("a[data-row-link]")?.click()

  return (
    <>
      {cells.map((c) => createPortal(<QboCell q={states[c.orderId]} onOpen={() => open(c.el)} />, c.el, `${c.orderId}-${cells.indexOf(c)}`))}
    </>
  )
}

export const config = defineWidgetConfig({
  zone: "order.list.before",
})

export default OrdersQboColumn

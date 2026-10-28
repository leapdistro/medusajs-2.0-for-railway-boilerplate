import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Input, Label, Switch, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useState } from "react"

/**
 * Analytics — sales, COGS, gross margin, payments received, open
 * balance and customers for a date range. Reads /admin/mbs/analytics
 * (see lib/analytics.ts for how each number is worked out). With
 * "Compare" on, the previous period of the same length is fetched too
 * and each headline shows the change.
 */

const ChartIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" /><path d="M7 15v3" /><path d="M11 10v8" /><path d="M15 12v6" /><path d="M19 6v12" />
  </svg>
)

type MoneyRow = {
  revenue: number; goods: number; shipping: number; cogs: number
  costed_goods: number; gross_profit: number; margin_pct: number | null
}
type Report = {
  range: { from: string; to: string; from_date: string; to_date: string; tz: string; bucket: "day" | "week" | "month" }
  sales: MoneyRow & { orders: number; canceled_orders: number; average_order: number }
  series: Array<MoneyRow & { key: string; orders: number }>
  product_lines: Array<MoneyRow & { name: string; units: number }>
  top_products: Array<MoneyRow & { name: string; line: string; units: number }>
  top_customers: Array<MoneyRow & { name: string; orders: number; first_order: boolean }>
  customers: { signed_up: number; approved: number; pending_applications: number; buying: number; first_time_buyers: number; repeat_buyers: number }
  missing_cost: Array<{ product: string; sku: string | null; orders: number[]; revenue: number }>
  estimated_cost: Array<{ product: string; sku: string | null; orders: number[]; pool_units: number }>
  refunds: { amount: number; count: number }
  payments: { error: string } | { total: number; count: number; on_portal_orders: number; other: number; by_date: Array<{ date: string; amount: number }> }
  open_balance: {
    total: number; count: number
    aging: Array<{ label: string; amount: number; count: number }>
    customers: Array<{ customer: string; amount: number; orders: number[]; oldest_days: number }>
  }
  orders: Array<{
    display_id: number; id: string; date: string; customer: string; goods: number; shipping: number
    revenue: number; cogs: number; gross_profit: number; margin_pct: number | null; cost_complete: boolean; cost_estimated: boolean
    payment_status: string | null
  }>
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago"

/* ---- Dates (local, YYYY-MM-DD) ---- */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const parseYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d) }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

type Preset = { key: string; label: string; range: () => [Date, Date] }
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
const PRESETS: Preset[] = [
  { key: "today", label: "Today", range: () => [today(), today()] },
  { key: "7d", label: "Last 7 days", range: () => [addDays(today(), -6), today()] },
  { key: "30d", label: "Last 30 days", range: () => [addDays(today(), -29), today()] },
  { key: "month", label: "This month", range: () => { const t = today(); return [new Date(t.getFullYear(), t.getMonth(), 1), t] } },
  { key: "last-month", label: "Last month", range: () => { const t = today(); return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)] } },
  { key: "quarter", label: "This quarter", range: () => { const t = today(); return [new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1), t] } },
  { key: "ytd", label: "Year to date", range: () => { const t = today(); return [new Date(t.getFullYear(), 0, 1), t] } },
]

/** The [from, to) timestamps for local dates fromDate..toDate inclusive. */
function rangeParams(fromDate: string, toDate: string) {
  const from = parseYmd(fromDate)
  const to = addDays(parseYmd(toDate), 1)
  return { from: from.toISOString(), to: to.toISOString() }
}
function previousPeriod(fromDate: string, toDate: string): [string, string] {
  const from = parseYmd(fromDate)
  const days = Math.round((parseYmd(toDate).getTime() - from.getTime()) / 86_400_000) + 1
  return [ymd(addDays(from, -days)), ymd(addDays(from, -1))]
}

/* ---- Formatting ---- */
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const usd2 = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`)
const fmtDay = (s: string) => parseYmd(s).toLocaleDateString("en-US", { month: "short", day: "numeric" })
const bucketLabel = (key: string, bucket: string) =>
  bucket === "month" ? parseYmd(`${key}-01`).toLocaleDateString("en-US", { month: "short", year: "numeric" })
  : bucket === "week" ? `Week of ${fmtDay(key)}`
  : fmtDay(key)

async function fetchReport(fromDate: string, toDate: string): Promise<Report> {
  const p = new URLSearchParams({ ...rangeParams(fromDate, toDate), tz: TZ })
  const res = await fetch(`/admin/mbs/analytics?${p}`, { credentials: "include" })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
  return json as Report
}

const AnalyticsPage = () => {
  const [preset, setPreset] = useState("month")
  const initial = PRESETS.find((p) => p.key === "month")!.range()
  const [fromDate, setFromDate] = useState(ymd(initial[0]))
  const [toDate, setToDate] = useState(ymd(initial[1]))
  const [compare, setCompare] = useState(true)
  const [report, setReport] = useState<Report | null>(null)
  const [prev, setPrev] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!fromDate || !toDate || fromDate > toDate) { setError("Pick a start date on or before the end date"); return }
    setLoading(true); setError(null)
    try {
      const [cur, before] = await Promise.all([
        fetchReport(fromDate, toDate),
        compare ? fetchReport(...previousPeriod(fromDate, toDate)) : Promise.resolve(null),
      ])
      setReport(cur); setPrev(before)
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load the report")
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate, compare])

  useEffect(() => { load() }, [load])

  const pickPreset = (p: Preset) => {
    const [a, b] = p.range()
    setPreset(p.key); setFromDate(ymd(a)); setToDate(ymd(b))
  }

  const prevLabel = compare ? (() => { const [a, b] = previousPeriod(fromDate, toDate); return `${fmtDay(a)} – ${fmtDay(b)}` })() : ""

  return (
    <div className="flex flex-col gap-4">
      <Container className="divide-y p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <Heading level="h1">Analytics</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Orders placed in the range (cancelled orders left out). Times in {TZ}.
            </Text>
          </div>
          <Button size="small" variant="secondary" disabled={!report} onClick={() => report && downloadCsv(report)}>
            Export orders CSV
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-6 py-4">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button key={p.key} size="small" variant={preset === p.key ? "primary" : "transparent"} onClick={() => pickPreset(p)}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label size="xsmall" htmlFor="an-from">From</Label>
              <Input id="an-from" size="small" type="date" value={fromDate} onChange={(e) => { setPreset("custom"); setFromDate(e.target.value) }} />
            </div>
            <div className="flex flex-col gap-1">
              <Label size="xsmall" htmlFor="an-to">To</Label>
              <Input id="an-to" size="small" type="date" value={toDate} onChange={(e) => { setPreset("custom"); setToDate(e.target.value) }} />
            </div>
          </div>
          <div className="flex items-center gap-2 pb-1">
            <Switch id="an-compare" checked={compare} onCheckedChange={setCompare} />
            <Label size="small" htmlFor="an-compare">Compare with previous period{compare ? ` (${prevLabel})` : ""}</Label>
          </div>
          <Button size="small" variant="secondary" isLoading={loading} onClick={load}>Refresh</Button>
        </div>
        {error && <div className="px-6 py-3"><Text size="small" className="text-ui-fg-error">{error}</Text></div>}
      </Container>

      {!report ? (
        <Container><Text className="text-ui-fg-muted">{loading ? "Loading…" : "No data"}</Text></Container>
      ) : (
        <Body report={report} prev={prev} loading={loading} />
      )}
    </div>
  )
}

function Body({ report: r, prev, loading }: { report: Report; prev: Report | null; loading: boolean }) {
  const pay = "error" in r.payments ? null : r.payments
  const prevPay = prev && !("error" in prev.payments) ? prev.payments : null
  return (
    <div className={`flex flex-col gap-4 ${loading ? "opacity-60" : ""}`}>
      {r.missing_cost.length > 0 && (
        <Container className="border-ui-tag-orange-border">
          <Text size="small" weight="plus">Cost missing on {r.missing_cost.length} product{r.missing_cost.length === 1 ? "" : "s"}</Text>
          <Text size="small" className="text-ui-fg-subtle">
            {usd(r.missing_cost.reduce((s, m) => s + m.revenue, 0))} of sales has no receiving cost, so it's left out of COGS and margin:{" "}
            {r.missing_cost.slice(0, 6).map((m) => `${m.product} (#${m.orders.join(", #")})`).join("; ")}
            {r.missing_cost.length > 6 ? "; …" : ""}
          </Text>
        </Container>
      )}

      {r.estimated_cost.length > 0 && (
        <Container>
          <Text size="small" weight="plus">
            {r.estimated_cost.reduce((s, e) => s + e.pool_units, 0)} units sold beyond what receiving history shows came in
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            FIFO ran out of received stock for these, so they're costed at the last receiving's cost (stock added by hand, before receiving history, or returned and resold):{" "}
            {r.estimated_cost.slice(0, 6).map((e) => `${e.product} ×${e.pool_units} (#${e.orders.join(", #")})`).join("; ")}
            {r.estimated_cost.length > 6 ? "; …" : ""}
          </Text>
        </Container>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Revenue" value={usd(r.sales.revenue)} now={r.sales.revenue} before={prev?.sales.revenue}
          sub={`${usd(r.sales.goods)} goods · ${usd(r.sales.shipping)} shipping`} />
        <Kpi label="Cost of goods" value={usd(r.sales.cogs)} now={r.sales.cogs} before={prev?.sales.cogs} lowerIsBetter
          sub="FIFO landed cost of what was sold" />
        <Kpi label="Gross profit" value={usd(r.sales.gross_profit)} now={r.sales.gross_profit} before={prev?.sales.gross_profit}
          sub={`${pct(r.sales.margin_pct)} margin on goods${prev ? ` (was ${pct(prev.sales.margin_pct)})` : ""}`} />
        <Kpi label="Orders" value={String(r.sales.orders)} now={r.sales.orders} before={prev?.sales.orders}
          sub={`${usd(r.sales.average_order)} average${r.sales.canceled_orders ? ` · ${r.sales.canceled_orders} cancelled` : ""}`} />
        <Kpi label="Payments received" value={pay ? usd(pay.total) : "—"} now={pay?.total} before={prevPay?.total}
          sub={pay ? `${pay.count} payment${pay.count === 1 ? "" : "s"} in QuickBooks${pay.other > 0.5 ? ` · ${usd(pay.other)} on non-portal invoices` : ""}` : ("error" in r.payments ? r.payments.error : "")} />
        <Kpi label="Refunds" value={usd(r.refunds.amount)} now={r.refunds.amount} before={prev?.refunds.amount} lowerIsBetter
          sub={`${r.refunds.count} refund${r.refunds.count === 1 ? "" : "s"} (card)`} />
        <Kpi label="New customers" value={String(r.customers.approved)} now={r.customers.approved} before={prev?.customers.approved}
          sub={`${r.customers.signed_up} applied · ${r.customers.pending_applications} waiting for review now`} />
        <Kpi label="Buying customers" value={String(r.customers.buying)} now={r.customers.buying} before={prev?.customers.buying}
          sub={`${r.customers.first_time_buyers} first order · ${r.customers.repeat_buyers} repeat`} />
      </div>

      <Container className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <Heading level="h2">Revenue by {r.range.bucket}</Heading>
          <Text size="xsmall" className="text-ui-fg-muted">Hover a bar for details</Text>
        </div>
        <Bars series={r.series} bucket={r.range.bucket} />
      </Container>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Container className="flex flex-col gap-3 p-0">
          <Heading level="h2" className="px-6 pt-4">By product line</Heading>
          <Table
            head={["Product line", "Units", "Revenue", "COGS", "Gross profit", "Margin"]}
            rows={r.product_lines.map((l) => [l.name, l.units, usd(l.revenue), usd(l.cogs), usd(l.gross_profit), pct(l.margin_pct)])}
          />
        </Container>
        <Container className="flex flex-col gap-3 p-0">
          <div className="flex items-baseline justify-between px-6 pt-4">
            <Heading level="h2">Open balance</Heading>
            <Text size="small" weight="plus">{usd(r.open_balance.total)} on {r.open_balance.count} orders</Text>
          </div>
          <Text size="xsmall" className="px-6 text-ui-fg-muted">Everything unpaid right now, aged by order date (not limited to the range).</Text>
          <div className="grid grid-cols-4 gap-2 px-6">
            {r.open_balance.aging.map((a) => (
              <div key={a.label} className="rounded-md border border-ui-border-base px-3 py-2">
                <Text size="xsmall" className="text-ui-fg-subtle">{a.label}</Text>
                <Text size="small" weight="plus">{usd(a.amount)}</Text>
                <Text size="xsmall" className="text-ui-fg-muted">{a.count} order{a.count === 1 ? "" : "s"}</Text>
              </div>
            ))}
          </div>
          <Table
            head={["Customer", "Owes", "Orders", "Oldest"]}
            rows={r.open_balance.customers.slice(0, 10).map((c) => [c.customer, usd2(c.amount), c.orders.map((o) => `#${o}`).join(", "), `${c.oldest_days} days`])}
          />
        </Container>
        <Container className="flex flex-col gap-3 p-0">
          <Heading level="h2" className="px-6 pt-4">Top customers</Heading>
          <Table
            head={["Customer", "Orders", "Revenue", "Gross profit", "Margin"]}
            rows={r.top_customers.map((c) => [
              <span key="n">{c.name}{c.first_order && <Badge size="2xsmall" color="green" className="ml-2">First order</Badge>}</span>,
              c.orders, usd(c.revenue), usd(c.gross_profit), pct(c.margin_pct),
            ])}
          />
        </Container>
        <Container className="flex flex-col gap-3 p-0">
          <Heading level="h2" className="px-6 pt-4">Top products</Heading>
          <Table
            head={["Product", "Line", "Units", "Revenue", "Margin"]}
            rows={r.top_products.map((p) => [p.name, p.line, p.units, usd(p.revenue), pct(p.margin_pct)])}
          />
        </Container>
      </div>

      <Container className="flex flex-col gap-3 p-0">
        <Heading level="h2" className="px-6 pt-4">Orders ({r.orders.length})</Heading>
        <Table
          head={["Order", "Date", "Customer", "Goods", "Shipping", "COGS", "Gross profit", "Margin", "Payment"]}
          rows={[...r.orders].reverse().map((o) => [
            <a key="o" href={`/app/orders/${o.id}`} className="text-ui-fg-interactive hover:underline">#{o.display_id}</a>,
            fmtDay(o.date), o.customer, usd2(o.goods), usd2(o.shipping),
            !o.cost_complete ? <span key="c" title="Some lines have no cost">{usd2(o.cogs)} *</span>
              : o.cost_estimated ? <span key="c" title="Part of this order is beyond received stock; costed at the last receiving's cost">≈ {usd2(o.cogs)}</span>
              : usd2(o.cogs),
            usd2(o.gross_profit), pct(o.margin_pct), o.payment_status ? o.payment_status.replace("_", " ") : "not invoiced",
          ])}
        />
      </Container>

      <Text size="xsmall" className="text-ui-fg-muted">
        Revenue counts goods the way the QuickBooks invoice bills them: what shipped minus returns, or what was ordered if nothing has shipped yet.
        COGS is FIFO, like QuickBooks: each receiving is a layer at its landed cost, and orders use up the oldest layer first. Margin is on goods only, because shipping costs aren't recorded.
        Payments are QuickBooks payments by payment date.
      </Text>
    </div>
  )
}

function Kpi({ label, value, sub, now, before, lowerIsBetter }: {
  label: string; value: string; sub?: string; now?: number; before?: number; lowerIsBetter?: boolean
}) {
  let delta: JSX.Element | null = null
  if (now != null && before != null) {
    if (before === 0) delta = now === 0 ? null : <Badge size="2xsmall" color="grey">new</Badge>
    else {
      const change = ((now - before) / Math.abs(before)) * 100
      const good = lowerIsBetter ? change < 0 : change > 0
      delta = Math.abs(change) < 0.05 ? <Badge size="2xsmall" color="grey">no change</Badge>
        : <Badge size="2xsmall" color={good ? "green" : "red"}>{change > 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%</Badge>
    }
  }
  return (
    <Container className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <Text size="xsmall" weight="plus" className="uppercase tracking-wide text-ui-fg-subtle">{label}</Text>
        {delta}
      </div>
      <Text className="text-2xl font-semibold tabular-nums text-ui-fg-base">{value}</Text>
      {sub && <Text size="xsmall" className="text-ui-fg-muted">{sub}</Text>}
    </Container>
  )
}

function Bars({ series, bucket }: { series: Report["series"]; bucket: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = useMemo(() => Math.max(1, ...series.map((s) => s.revenue)), [series])
  if (series.length === 0) return <Text size="small" className="text-ui-fg-muted">No orders</Text>
  const h = hover != null ? series[hover] : null
  const every = Math.ceil(series.length / 12)
  return (
    <div className="flex flex-col gap-1">
      <div className="h-6">
        {h && (
          <Text size="small" className="tabular-nums">
            <span className="font-medium">{bucketLabel(h.key, bucket)}</span> · {usd(h.revenue)} revenue · {usd(h.gross_profit)} gross profit · {h.orders} order{h.orders === 1 ? "" : "s"}
          </Text>
        )}
      </div>
      <div className="flex h-48 items-end gap-[2px] border-b border-ui-border-base" onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => (
          <div key={s.key} className="flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)}>
            <div
              className={`w-full rounded-t ${hover === i ? "bg-ui-fg-interactive-hover" : "bg-ui-fg-interactive"}`}
              style={{ height: `${(s.revenue / max) * 100}%`, minHeight: s.revenue > 0 ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-[2px]">
        {series.map((s, i) => (
          <div key={s.key} className="flex-1 overflow-visible whitespace-nowrap text-center">
            {i % every === 0 && <Text size="xsmall" className="text-ui-fg-muted">{bucket === "month" ? bucketLabel(s.key, bucket) : fmtDay(s.key)}</Text>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <Text size="small" className="px-6 pb-4 text-ui-fg-muted">Nothing in this range</Text>
  return (
    <div className="overflow-x-auto pb-2">
      <table className="w-full text-left">
        <thead>
          <tr className="border-y border-ui-border-base bg-ui-bg-subtle">
            {head.map((h, i) => (
              <th key={h} className={`px-6 py-2 txt-compact-xsmall-plus text-ui-fg-subtle ${i > 0 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-ui-border-base last:border-0 hover:bg-ui-bg-base-hover">
              {r.map((c, j) => (
                <td key={j} className={`px-6 py-2 txt-compact-small tabular-nums ${j > 0 ? "text-right" : ""}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function downloadCsv(r: Report) {
  const cols = ["order", "date", "customer", "goods", "shipping", "revenue", "cogs", "gross_profit", "margin_pct", "cost_complete", "cost_estimated", "payment_status"]
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const lines = [cols.join(",")].concat(r.orders.map((o) => [
    o.display_id, o.date, o.customer, o.goods, o.shipping, o.revenue, o.cogs, o.gross_profit, o.margin_pct, o.cost_complete, o.cost_estimated, o.payment_status,
  ].map(esc).join(",")))
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }))
  const a = document.createElement("a")
  a.href = url; a.download = `mbs-orders-${r.range.from_date}-to-${r.range.to_date}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast.success("CSV downloaded")
}

export const config = defineRouteConfig({
  label: "Analytics",
  icon: ChartIcon,
})

export default AnalyticsPage

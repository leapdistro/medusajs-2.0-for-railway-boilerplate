import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Badge,
  Button,
  Container,
  Heading,
  Label,
  Select,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

/**
 * Product Lines — retire / reactivate a cannabinoid branch (or any future
 * product line) in one operator click. Reads /admin/product-lines for
 * per-branch state + audit history, posts to /admin/product-lines/retire
 * or /reactivate to mutate state.
 *
 * State pill:
 *   active   → latest audit is reactivate (or no history + intermediate
 *              category is active)
 *   retired  → latest audit is retire
 *   unknown  → intermediate category was deactivated outside this system
 *              (state drift — flag it so operator can investigate)
 *
 * The retire action DOES three things atomically-ish:
 *   1. Deactivates the branch's categories in Medusa
 *   2. Bulk `status: draft` on every currently-published product in
 *      the branch subtree
 *   3. Writes an audit entry with the productIds — reactivate uses
 *      that entry to re-publish precisely those products (nothing
 *      added since retire gets accidentally re-published)
 */

/* Inline shield icon — sized 20×20 to match the admin sidebar's other
 * icons (matches the GearIcon / TruckIcon pattern used by MBS Settings +
 * Receiving). No @medusajs/icons dependency. */
const ShieldIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
)

type BranchState = "active" | "retired" | "unknown"
type BranchSummary = {
  key: string
  displayName: string
  state: BranchState
  counts: {
    categoriesConfigured: number
    categoriesFound: number
    categoriesActive: number
    productsPublished: number
    productsDraft: number
    productsArchived: number
  }
  lastAction: {
    action: "retire" | "reactivate"
    actor: string
    reason: string
    timestamp: string
  } | null
}

type AuditEntry = {
  id: string
  timestamp: string
  actor: string
  action: "retire" | "reactivate"
  branch: string
  reason: string
  notes?: string
  categoryIds: string[]
  productIds: string[]
  categoriesToggled: number
  productsUpdated: number
}

type ApiResponse = {
  ok: boolean
  branches: BranchSummary[]
  recentAudit: AuditEntry[]
}

/* Mirror of REASON_CODES in backend/src/lib/product-lines.ts. Kept
 * inline here so the admin bundle doesn't import from src/lib
 * (Medusa's admin build treats them as separate compilation targets;
 * duplicating a ~7-entry constant is cheaper than a bundler rule). */
const REASON_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "texas_sb3",           label: "Texas SB3 (total-THC rule)" },
  { id: "state_rule_change",   label: "State rule change (other state)" },
  { id: "federal_rule_change", label: "Federal rule change (Farm Bill / DEA / etc.)" },
  { id: "legal_hold",          label: "Legal hold (pending litigation)" },
  { id: "supply_shortage",     label: "Supply shortage" },
  { id: "discontinued",        label: "Discontinued product line" },
  { id: "seasonal_pause",      label: "Seasonal pause" },
  { id: "other",               label: "Other (see notes)" },
]

function reasonLabel(id: string): string {
  return REASON_OPTIONS.find((r) => r.id === id)?.label ?? id
}

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function stateColor(state: BranchState): "green" | "red" | "orange" {
  return state === "active" ? "green" : state === "retired" ? "red" : "orange"
}
function stateLabel(state: BranchState): string {
  return state === "active" ? "Active" : state === "retired" ? "Retired" : "Unknown"
}

const ProductLinesPage = () => {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /* The confirm modal is a single dialog reused for both actions —
   * `pending` holds the branch + action being confirmed. null = closed. */
  const [pending, setPending] = useState<{
    branch: string
    displayName: string
    action: "retire" | "reactivate"
  } | null>(null)
  const [reason, setReason] = useState<string>("texas_sb3")
  const [notes, setNotes] = useState<string>("")
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/admin/product-lines", { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ApiResponse
      setData(json)
    } catch (e: any) {
      setError(e?.message ?? "Load failed")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openModal = (branch: BranchSummary, action: "retire" | "reactivate") => {
    setPending({ branch: branch.key, displayName: branch.displayName, action })
    setReason("texas_sb3")
    setNotes("")
  }
  const closeModal = () => {
    if (submitting) return
    setPending(null)
  }

  const confirm = async () => {
    if (!pending) return
    setSubmitting(true)
    try {
      const res = await fetch(`/admin/product-lines/${pending.action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: pending.branch, reason, notes: notes.trim() || undefined }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      const s = json.summary ?? {}
      const verb = pending.action === "retire" ? "Retired" : "Reactivated"
      toast.success(`${verb} · ${s.productsUpdated ?? 0} products, ${s.categoriesToggled ?? 0} categories`)
      setPending(null)
      /* Refresh state + audit tail immediately so the pill flips and
       * the new audit entry appears without a manual reload. */
      load()
    } catch (e: any) {
      toast.error(e?.message ?? "Action failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Container className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <Heading level="h1">Product Lines</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Retire or reactivate a cannabinoid branch when state rules change. Retire deactivates the branch's Medusa categories and drafts every published product in the subtree; reactivate reverses precisely what was retired. Every action is logged.
        </Text>
      </div>

      {loading ? (
        <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
      ) : error ? (
        <div className="border border-ui-border-error p-4">
          <Text size="small" className="text-ui-fg-error">{error}</Text>
          <Button size="small" variant="secondary" onClick={load} className="mt-2">Retry</Button>
        </div>
      ) : data ? (
        <>
          {/* Branch table */}
          <div className="border">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)] border-b bg-ui-bg-subtle">
              <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Branch</div>
              <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">State</div>
              <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Products</div>
              <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Last action</div>
              <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle text-right">&nbsp;</div>
            </div>

            {data.branches.map((b, i) => (
              <div
                key={b.key}
                className={`grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)]${i < data.branches.length - 1 ? " border-b" : ""}`}
              >
                <div className="px-3 py-3 flex flex-col gap-0.5">
                  <span className="font-medium text-sm">{b.displayName}</span>
                  <span className="text-xs text-ui-fg-subtle">
                    {b.counts.categoriesActive} / {b.counts.categoriesConfigured} categories active
                  </span>
                </div>
                <div className="px-3 py-3 flex items-center">
                  <Badge color={stateColor(b.state)}>{stateLabel(b.state)}</Badge>
                </div>
                <div className="px-3 py-3 flex flex-col gap-0.5 text-sm">
                  <span>
                    <span className="text-ui-fg-base">{b.counts.productsPublished}</span>
                    <span className="text-ui-fg-subtle"> published · </span>
                    <span className="text-ui-fg-base">{b.counts.productsDraft}</span>
                    <span className="text-ui-fg-subtle"> draft</span>
                  </span>
                  {b.counts.productsArchived > 0 && (
                    <span className="text-xs text-ui-fg-subtle">{b.counts.productsArchived} archived</span>
                  )}
                </div>
                <div className="px-3 py-3 flex flex-col gap-0.5 text-sm">
                  {b.lastAction ? (
                    <>
                      <span className="capitalize">{b.lastAction.action} · {reasonLabel(b.lastAction.reason)}</span>
                      <span className="text-xs text-ui-fg-subtle">
                        {fmtTs(b.lastAction.timestamp)} · {b.lastAction.actor}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-ui-fg-subtle">No history</span>
                  )}
                </div>
                <div className="px-3 py-3 flex items-center justify-end gap-2">
                  {b.state === "retired" ? (
                    <Button size="small" variant="primary" onClick={() => openModal(b, "reactivate")}>
                      Reactivate
                    </Button>
                  ) : (
                    <Button size="small" variant="danger" onClick={() => openModal(b, "retire")}>
                      Retire
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* State drift warning — unknown means intermediate was
              deactivated outside this system. Flag it so ops fixes. */}
          {data.branches.some((b) => b.state === "unknown") && (
            <div className="border border-ui-border-warning p-3">
              <Text size="small" weight="plus">Heads up: state drift detected</Text>
              <Text size="small" className="text-ui-fg-subtle mt-1">
                One or more branches show as <strong>Unknown</strong>. That usually means the intermediate category was deactivated in the standard Medusa admin (not via this dashboard). Run a Retire from here to synchronise state + capture an audit entry, or reactivate the category directly if the deactivation was accidental.
              </Text>
            </div>
          )}

          {/* Audit log */}
          <div className="flex flex-col gap-2">
            <Heading level="h2">Recent audit history</Heading>
            {data.recentAudit.length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">No actions logged yet.</Text>
            ) : (
              <div className="border">
                <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,3fr)] border-b bg-ui-bg-subtle">
                  <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">When</div>
                  <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Action</div>
                  <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Branch</div>
                  <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Reason</div>
                  <div className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-ui-fg-subtle">Detail</div>
                </div>
                {data.recentAudit.map((e, i) => (
                  <div
                    key={e.id}
                    className={`grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,3fr)]${i < data.recentAudit.length - 1 ? " border-b" : ""}`}
                  >
                    <div className="px-3 py-2 text-xs flex flex-col gap-0.5">
                      <span>{fmtTs(e.timestamp)}</span>
                      <span className="text-ui-fg-subtle">{e.actor}</span>
                    </div>
                    <div className="px-3 py-2 text-sm capitalize flex items-center">{e.action}</div>
                    <div className="px-3 py-2 text-sm flex items-center uppercase tracking-wider">{e.branch}</div>
                    <div className="px-3 py-2 text-sm flex items-center">{reasonLabel(e.reason)}</div>
                    <div className="px-3 py-2 text-xs flex flex-col gap-0.5">
                      <span>{e.productsUpdated} products, {e.categoriesToggled} categories</span>
                      {e.notes && <span className="text-ui-fg-subtle italic">{e.notes}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* Confirm modal — inline card matching the MBS Settings confirmApply
          pattern (no dependency on a modal component, still visually distinct). */}
      {pending && (
        <div className="border border-ui-border-base bg-ui-bg-subtle p-4 flex flex-col gap-3 max-w-2xl">
          <div className="flex flex-col gap-1">
            <Text size="base" weight="plus">
              {pending.action === "retire" ? `Retire ${pending.displayName}?` : `Reactivate ${pending.displayName}?`}
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              {pending.action === "retire"
                ? "Deactivates the branch categories in Medusa AND sets status: draft on every currently-published product in the subtree. Fully reversible via Reactivate."
                : "Reactivates the branch categories from the most recent Retire audit entry AND re-publishes exactly the products that Retire drafted. Products added since Retire are unaffected."}
            </Text>
          </div>

          <div className="flex flex-col gap-2">
            <Label size="small" htmlFor="pl-reason">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <Select.Trigger id="pl-reason"><Select.Value /></Select.Trigger>
              <Select.Content>
                {REASON_OPTIONS.map((r) => (
                  <Select.Item key={r.id} value={r.id}>{r.label}</Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label size="small" htmlFor="pl-notes">Notes (optional)</Label>
            <Textarea
              id="pl-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Case number, statute reference, ticket link — anything future-ops will want to see when reading the log."
              rows={2}
              maxLength={500}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              variant={pending.action === "retire" ? "danger" : "primary"}
              onClick={confirm}
              isLoading={submitting}
            >
              {pending.action === "retire" ? "Yes, Retire" : "Yes, Reactivate"}
            </Button>
            <Button variant="secondary" onClick={closeModal} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Product Lines",
  icon: ShieldIcon,
})

export default ProductLinesPage

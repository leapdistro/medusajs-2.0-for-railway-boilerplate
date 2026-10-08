import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type Job = {
  id: string
  order_id: string
  display_id: number | null
  attempts: number
  reasons: string
  last_error: string | null
  last_error_code: string | null
  updated_at: string
}

/**
 * Orders list → "Failed QuickBooks syncs". Order changes that couldn't
 * reach QBO after automatic retries (or for a reason retrying can't fix)
 * land here instead of only in the bell. Hidden when there are none.
 */
const FailedQboSyncsWidget = () => {
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/admin/qbo/sync-jobs?status=failed`, { credentials: "include", cache: "no-store" })
      const json = await res.json()
      setJobs(json?.jobs ?? [])
    } catch { /* panel just stays hidden */ }
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (job: Job, action: "retry" | "dismiss") => {
    setBusy(job.id)
    try {
      const res = await fetch(`/admin/qbo/sync-jobs/${job.id}/${action}`, { method: "POST", credentials: "include" })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `${action} failed`)
      toast.success(action === "retry" ? "QuickBooks synced" : "Dismissed", { description: json.message ?? `Order #${job.display_id ?? ""}` })
    } catch (e: any) {
      toast.error(action === "retry" ? "Still failing" : "Dismiss failed", { description: e?.message })
    } finally {
      setBusy(null)
      load()
    }
  }

  if (jobs.length === 0) return null
  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Failed QuickBooks syncs</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            These order changes didn&apos;t reach QuickBooks. Fix the cause, then Retry — or Dismiss once handled in QuickBooks.
          </Text>
        </div>
        <Badge color="red">{jobs.length}</Badge>
      </div>
      {jobs.map((j) => (
        <div key={j.id} className="flex items-start justify-between gap-4 px-6 py-3">
          <div className="min-w-0">
            <Text size="small" weight="plus">
              <a href={`/app/orders/${j.order_id}`} className="underline">Order #{j.display_id ?? j.order_id.slice(0, 10)}</a>
              {" · "}{j.last_error_code ?? "error"} · {j.attempts} attempt{j.attempts === 1 ? "" : "s"}
            </Text>
            <Text size="xsmall" className="text-ui-fg-subtle" style={{ wordBreak: "break-word" }}>{j.last_error}</Text>
            <Text size="xsmall" className="text-ui-fg-muted">
              {new Date(j.updated_at).toLocaleString()} · triggered by {j.reasons.split(",").join(", ")}
            </Text>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="small" variant="secondary" isLoading={busy === j.id} onClick={() => act(j, "retry")}>Retry</Button>
            <Button size="small" variant="transparent" disabled={busy === j.id} onClick={() => act(j, "dismiss")}>Dismiss</Button>
          </div>
        </div>
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.list.before",
})

export default FailedQboSyncsWidget

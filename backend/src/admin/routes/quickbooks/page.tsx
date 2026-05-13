import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type Status =
  | { connected: false }
  | {
      connected: true
      realm_id: string
      environment: string
      company_name: string | null
      last_bill_pushed_at: string | null
      last_bill_id: string | null
      refresh_expires_at: string
    }

const QuickBooksPage = () => {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/admin/qbo/status", { credentials: "include" })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`)
      }
      const json = (await res.json()) as Status
      /* Defensive: the server should always send connected as a boolean,
       * but if the route is misbehaving (500 swallowed somewhere) we
       * treat anything that isn't explicitly true as disconnected. */
      if (typeof (json as any).connected !== "boolean") {
        throw new Error("Malformed status response")
      }
      setStatus(json)
    } catch (e: any) {
      setStatus({ connected: false })
      toast.error("Failed to load QuickBooks status: " + (e?.message ?? "unknown"))
    }
  }, [])

  useEffect(() => {
    refresh()
    /* Surface flash messages from the OAuth callback redirect. */
    const params = new URLSearchParams(window.location.search)
    if (params.get("connected") === "1") {
      toast.success("QuickBooks connected")
      window.history.replaceState(null, "", window.location.pathname)
    }
    const error = params.get("error")
    if (error) {
      toast.error(`Connection failed: ${error}`)
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [refresh])

  const onConnect = () => {
    /* Full navigation (not fetch) — OAuth flow needs the browser to
     * follow the redirect chain through Intuit. */
    window.location.href = "/admin/qbo/connect"
  }

  const onDisconnect = async () => {
    if (!confirm("Disconnect QuickBooks? You'll have to re-authorize to push bills again.")) return
    setBusy(true)
    try {
      const res = await fetch("/admin/qbo/disconnect", {
        method: "POST",
        credentials: "include",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success("Disconnected")
      await refresh()
    } catch (e: any) {
      toast.error("Disconnect failed: " + (e?.message ?? "unknown"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">QuickBooks Online</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Push receiving bills directly to QBO. Connect once; tokens refresh automatically.
          </Text>
        </div>
      </div>

      {status === null ? (
        <div className="px-6 py-6">
          <Text className="text-ui-fg-muted">Loading…</Text>
        </div>
      ) : status.connected === false ? (
        <div className="flex items-center justify-between px-6 py-6">
          <Text className="text-ui-fg-subtle">Not connected.</Text>
          <Button variant="primary" onClick={onConnect}>Connect QuickBooks</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-6 py-6">
          <div className="grid grid-cols-2 gap-4">
            <KV label="Environment" value={status.environment} />
            <KV label="Realm / Company ID" value={status.realm_id} />
            <KV label="Last bill pushed" value={fmtDate(status.last_bill_pushed_at)} />
            <KV label="Refresh expires" value={fmtDate(status.refresh_expires_at)} />
          </div>
          <div className="flex justify-end">
            <Button variant="danger" onClick={onDisconnect} isLoading={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Container>
  )
}

function KV({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <Text size="xsmall" weight="plus" className="text-ui-fg-subtle uppercase tracking-wide">
        {label}
      </Text>
      <Text size="small" className="text-ui-fg-base">
        {value ?? "—"}
      </Text>
    </div>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export const config = defineRouteConfig({
  label: "QuickBooks",
})

export default QuickBooksPage

import { Button, toast } from "@medusajs/ui"
import { useState } from "react"

/**
 * "Announce" on a saved receiving: makes a Marketing draft featuring a
 * handful of its products (POST /admin/marketing/from-receiving/:id)
 * and opens it. Nothing is sent from here.
 */
export function AnnounceReceivingButton({ historyId, size = "base" }: { historyId: string; size?: "small" | "base" }) {
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/admin/marketing/from-receiving/${historyId}`, { method: "POST", credentials: "include" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.campaign?.id) throw new Error(json?.message ?? `Failed (${res.status})`)
      window.location.href = `/app/marketing/${json.campaign.id}`
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't make the email")
      setBusy(false)
    }
  }
  return <Button variant="secondary" size={size} onClick={go} isLoading={busy}>Announce to customers</Button>
}

import { Button, toast } from "@medusajs/ui"
import { useState } from "react"

/**
 * "Announce" on a saved receiving: opens its Marketing draft (made from
 * the receiving template, automatically on save or now) on Review &
 * send (POST /admin/marketing/from-receiving/:id). Nothing is sent from here.
 */
export function AnnounceReceivingButton({ historyId, size = "base" }: { historyId: string; size?: "small" | "base" }) {
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/admin/marketing/from-receiving/${historyId}`, { method: "POST", credentials: "include" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.campaign?.id) throw new Error(json?.message ?? `Failed (${res.status})`)
      /* Everything is filled from the receiving template: open on Review & send. */
      window.location.href = `/app/marketing/${json.campaign.id}#step=4`
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't make the email")
      setBusy(false)
    }
  }
  return <Button variant="secondary" size={size} onClick={go} isLoading={busy}>Announce to customers</Button>
}

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useState } from "react"

type CustomerLite = {
  id: string
  email?: string
}

/**
 * Customer detail widget — Cascade Delete.
 *
 * Sits at the bottom of the customer detail page. One button: "Delete
 * & Free Email" — wipes the Customer record AND the orphan
 * auth_identity / provider_identity rows so the email can re-register.
 *
 * Why this exists: Medusa's standard delete-customer button only
 * removes the Customer row. The auth_identity for emailpass remains,
 * blocking the email from re-applying ("ALREADY_APPROVED" on the
 * apply form). Operators kept hitting this — script-only fix wasn't
 * convenient enough, hence this widget.
 *
 * Confirmation flow:
 *   - First click → button label changes to "Confirm Delete?" + cancel link
 *   - Second click within 5s → POST /admin/customers/:id/cascade-delete
 *   - Auto-resets if not confirmed
 */
const CustomerCascadeDeleteWidget = ({ data: customer }: DetailWidgetProps<CustomerLite>) => {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (!customer?.id) return null

  const onClick = async () => {
    if (!confirming) {
      setConfirming(true)
      /* Auto-cancel confirmation after 5s so the operator doesn't
       * accidentally double-click much later. */
      setTimeout(() => setConfirming(false), 5000)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${customer.id}/cascade-delete`, {
        method: "POST",
        credentials: "include",
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        throw new Error(json?.message ?? `HTTP ${res.status}`)
      }
      const s = json.summary ?? {}
      toast.success("Customer fully deleted", {
        description: `${s.email} — auth identities removed: ${s.authIdentitiesDeleted}`,
      })
      /* Customer is gone — bounce back to the list. Using
       * window.location since Medusa admin SDK doesn't expose its
       * router. Brief delay so the success toast is visible first. */
      setTimeout(() => { window.location.href = "/app/customers" }, 600)
    } catch (e: any) {
      toast.error("Cascade delete failed", { description: e?.message ?? "Network error" })
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Danger Zone</Heading>
      </div>
      <div className="flex flex-col gap-y-3 px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          Fully delete this customer + their auth identity. The email
          becomes free to re-register. Cannot be undone.
        </Text>
        <div className="flex items-center gap-3">
          <Button
            variant={confirming ? "danger" : "secondary"}
            disabled={busy}
            onClick={onClick}
          >
            {busy ? "Deleting…" : confirming ? "Confirm Delete? (click again)" : "Delete & Free Email"}
          </Button>
          {confirming && !busy && (
            <Button variant="transparent" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.after",
})

export default CustomerCascadeDeleteWidget

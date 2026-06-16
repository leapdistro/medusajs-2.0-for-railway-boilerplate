import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { Container, Heading, RadioGroup, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type CustomerLite = {
  id: string
  email?: string
  metadata?: Record<string, any> | null
}

type Mode = "default" | "owner_stores" | "distro" | "tier_2" | "tier_3"

const OPTIONS: { id: Mode; label: string; help: string }[] = [
  {
    id: "default",
    label: "Default tier prices",
    help: "Regular B2B buyer — sees the operator-set tier prices from Settings.",
  },
  {
    id: "tier_2",
    label: "Tier 2",
    help: "Sees the Tier 2 prices from the Flower / Pre-Roll Tier Prices tabs.",
  },
  {
    id: "tier_3",
    label: "Tier 3",
    help: "Sees the Tier 3 prices from the Flower / Pre-Roll Tier Prices tabs.",
  },
  {
    id: "owner_stores",
    label: "Owner Stores",
    help: "Pays landed cost + the admin markup (Settings → Owner Markup). For your own retail outlets.",
  },
  {
    id: "distro",
    label: "Distro",
    help: "Pays the Distro tier prices from Settings. For distributor accounts.",
  },
]

/**
 * Customer pricing mode — picks which price table this buyer sees at
 * PDP, cart, checkout. Mutually exclusive with itself; orthogonal to
 * Net 15 (a buyer can be Net 15 AND on owner-store pricing).
 *
 * Stored on customer.metadata.pricing_mode ("owner_stores" | "distro" |
 * null/absent for default). Also keeps customer_groups membership in
 * sync — the storefront's price routes + Medusa price lists key off the
 * group, so the metadata is for admin display and the group is what
 * actually drives pricing.
 */
const CustomerPricingModeWidget = ({ data }: DetailWidgetProps<CustomerLite>) => {
  const [customer, setCustomer] = useState<CustomerLite | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!data?.id) return
    try {
      const res = await fetch(`/admin/customers/${data.id}?fields=id,email,metadata`, {
        credentials: "include",
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCustomer(json?.customer ?? null)
    } catch {
      setCustomer(data)
    } finally {
      setLoading(false)
    }
  }, [data])

  useEffect(() => { refresh() }, [refresh])

  const rawMode = customer?.metadata?.pricing_mode
  const current: Mode =
    rawMode === "owner_stores" ? "owner_stores"
    : rawMode === "distro" ? "distro"
    : rawMode === "tier_2" ? "tier_2"
    : rawMode === "tier_3" ? "tier_3"
    : "default"

  const onPick = async (next: Mode) => {
    if (!customer?.id || next === current) return
    setBusy(true)
    try {
      const res = await fetch(`/admin/customers/${customer.id}/pricing-mode`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next === "default" ? null : next }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success(`Pricing mode → ${OPTIONS.find((o) => o.id === next)?.label}`)
      await refresh()
    } catch (e: any) {
      toast.error("Could not update: " + (e?.message ?? "unknown"))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h2">Pricing Mode</Heading>
          <Text size="small" className="text-ui-fg-muted">Loading…</Text>
        </div>
      </Container>
    )
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Pricing Mode</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Which price table this buyer sees on storefront + checkout. Separate from Net 15.
        </Text>
        <div style={{ marginTop: 12 }}>
          <RadioGroup value={current} onValueChange={(v) => onPick(v as Mode)} disabled={busy}>
            {OPTIONS.map((opt) => (
              <div key={opt.id} className="flex items-start gap-3" style={{ padding: "8px 0" }}>
                <RadioGroup.Item value={opt.id} id={`pm-${opt.id}`} />
                <div>
                  <label htmlFor={`pm-${opt.id}`} style={{ fontWeight: 600, cursor: "pointer" }}>
                    {opt.label}
                  </label>
                  <Text size="small" className="text-ui-fg-muted">{opt.help}</Text>
                </div>
              </div>
            ))}
          </RadioGroup>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "customer.details.before",
})

export default CustomerPricingModeWidget

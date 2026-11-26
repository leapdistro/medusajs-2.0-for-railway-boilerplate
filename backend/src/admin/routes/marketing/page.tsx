import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { api, fmtDate, STATUS_LABEL, type Campaign, type Sending } from "../../components/marketing/api"

/**
 * Admin → Marketing: campaign list. Emails are built from on-brand
 * blocks (lib/marketing/blocks.ts), sent only to approved customers,
 * minus anyone who unsubscribed (lib/marketing/audience.ts).
 */

const MailIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
  </svg>
)

const MarketingPage = () => {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [sending, setSending] = useState<Sending | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api<{ campaigns: Campaign[]; sending: Sending }>("/admin/marketing/campaigns")
      .then((r) => { setCampaigns(r.campaigns); setSending(r.sending) })
      .catch((e) => { toast.error(e?.message ?? "Couldn't load campaigns"); setCampaigns([]) })
  }, [])

  const create = async () => {
    setCreating(true)
    try {
      const r = await api<{ campaign: Campaign }>("/admin/marketing/campaigns", { body: {} })
      window.location.href = `/app/marketing/${r.campaign.id}`
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't create")
      setCreating(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">Marketing</Heading>
          <Text size="small" className="text-ui-fg-subtle">On-brand emails to approved customers. Each buyer sees their own prices.</Text>
        </div>
        <Button onClick={create} isLoading={creating}>New campaign</Button>
      </div>

      {sending && !sending.ready ? (
        <div className="px-6 py-3" style={{ background: "var(--tag-orange-bg, #fff7ed)" }}>
          <Text size="small"><strong>Sending isn't switched on yet.</strong> You can write and preview campaigns; test and send stay off until it's set up. {sending.reason}</Text>
        </div>
      ) : null}

      <div className="px-6 py-4">
        {campaigns === null ? <Text size="small" className="text-ui-fg-subtle">Loading…</Text> : null}
        {campaigns?.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ui-border-strong px-6 py-10 text-center">
            <Heading level="h2">No campaigns yet</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">Start one here, or use "Announce" on a receiving to feature what just landed.</Text>
            <div className="mt-4"><Button onClick={create} isLoading={creating}>New campaign</Button></div>
          </div>
        ) : null}
        {campaigns && campaigns.length > 0 ? (
          <table className="w-full txt-compact-small">
            <thead>
              <tr className="text-left text-ui-fg-subtle border-b border-ui-border-base">
                <th className="py-2 font-normal">Campaign</th>
                <th className="py-2 font-normal">Status</th>
                <th className="py-2 font-normal">Recipients</th>
                <th className="py-2 font-normal">When</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.draft
                const when = c.status === "scheduled" ? `For ${fmtDate(c.scheduled_at)}` : c.sent_at ? `Sent ${fmtDate(c.sent_at)}` : `Edited ${fmtDate(c.updated_at)}`
                return (
                  <tr key={c.id} className="border-b border-ui-border-base last:border-b-0 hover:bg-ui-bg-base-hover cursor-pointer" onClick={() => { window.location.href = `/app/marketing/${c.id}` }}>
                    <td className="py-3 pr-4">
                      <Text size="small" weight="plus">{c.name}</Text>
                      <Text size="xsmall" className="text-ui-fg-subtle truncate" style={{ maxWidth: 420 }}>{c.subject || "No subject yet"}</Text>
                    </td>
                    <td className="py-3 pr-4"><Badge size="2xsmall" color={st.color}>{st.label}</Badge></td>
                    <td className="py-3 pr-4">
                      {c.status === "draft" || c.status === "scheduled"
                        ? <Text size="small" className="text-ui-fg-subtle">{c.status === "scheduled" ? c.recipient_count : "—"}</Text>
                        : <Text size="small">{c.sent_count} sent{c.failed_count ? <span style={{ color: "var(--fg-error, #b91c1c)" }}> · {c.failed_count} failed</span> : null}</Text>}
                    </td>
                    <td className="py-3"><Text size="small" className="text-ui-fg-subtle">{when}</Text></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Marketing",
  icon: MailIcon,
})

export default MarketingPage

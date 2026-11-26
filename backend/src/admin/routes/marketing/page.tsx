import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { api, fmtDate, STATUS_LABEL, type Campaign, type Sending } from "../../components/marketing/api"
import { Modal } from "../../components/marketing/modal"

/**
 * Admin → Marketing: campaigns and saved templates. Emails are built
 * from on-brand blocks (lib/marketing/blocks.ts), sent only to approved
 * customers, minus anyone who unsubscribed. One template can be marked
 * for receiving announcements: each saved receiving gets a draft made
 * from it automatically (bell notice), never sent without the admin.
 */

const MailIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
  </svg>
)

const tabFromHash = () => (window.location.hash === "#templates" ? "templates" : "campaigns")

const MarketingPage = () => {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [templates, setTemplates] = useState<Campaign[]>([])
  const [sending, setSending] = useState<Sending | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<"campaigns" | "templates">(tabFromHash)
  const [choosing, setChoosing] = useState(false)

  useEffect(() => {
    api<{ campaigns: Campaign[]; templates: Campaign[]; sending: Sending }>("/admin/marketing/campaigns")
      .then((r) => { setCampaigns(r.campaigns); setTemplates(r.templates); setSending(r.sending) })
      .catch((e) => { toast.error(e?.message ?? "Couldn't load campaigns"); setCampaigns([]) })
  }, [])

  const pickTab = (t: "campaigns" | "templates") => {
    setTab(t)
    try { window.history.replaceState(null, "", t === "templates" ? "#templates" : "#") } catch { /* ignore */ }
  }

  const go = async (path: string, body: unknown) => {
    setBusy(true)
    try {
      const r = await api<{ campaign: Campaign }>(path, { body })
      window.location.href = `/app/marketing/${r.campaign.id}`
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't create")
      setBusy(false)
    }
  }
  const newCampaign = () => (templates.length ? setChoosing(true) : go("/admin/marketing/campaigns", {}))

  const rowsFor = (list: Campaign[], isTemplate: boolean) => (
    <table className="w-full txt-compact-small">
      <thead>
        <tr className="text-left text-ui-fg-subtle border-b border-ui-border-base">
          <th className="py-2 font-normal">{isTemplate ? "Template" : "Campaign"}</th>
          <th className="py-2 font-normal">{isTemplate ? "Used for" : "Status"}</th>
          {!isTemplate ? <th className="py-2 font-normal">Recipients</th> : null}
          <th className="py-2 font-normal">When</th>
        </tr>
      </thead>
      <tbody>
        {list.map((c) => {
          const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.draft
          const src = c.source as any
          const when = c.status === "scheduled" ? `For ${fmtDate(c.scheduled_at)}` : c.sent_at ? `Sent ${fmtDate(c.sent_at)}` : `Edited ${fmtDate(c.updated_at)}`
          return (
            <tr key={c.id} className="border-b border-ui-border-base last:border-b-0 hover:bg-ui-bg-base-hover cursor-pointer" onClick={() => { window.location.href = `/app/marketing/${c.id}` }}>
              <td className="py-3 pr-4">
                <Text size="small" weight="plus">{c.name}</Text>
                <Text size="xsmall" className="text-ui-fg-subtle truncate" style={{ maxWidth: 440 }}>
                  {c.subject || "No subject yet"}
                  {!isTemplate && src?.type === "receiving" && src?.auto && !src?.edited && c.status === "draft" ? " · made automatically from a receiving" : ""}
                </Text>
              </td>
              <td className="py-3 pr-4">
                {isTemplate
                  ? (c.template_role === "receiving" ? <Badge size="2xsmall" color="green">Receiving announcements</Badge> : <Text size="small" className="text-ui-fg-subtle">Start of new campaigns</Text>)
                  : <Badge size="2xsmall" color={st.color}>{st.label}</Badge>}
              </td>
              {!isTemplate ? (
                <td className="py-3 pr-4">
                  {c.status === "draft" || c.status === "scheduled"
                    ? <Text size="small" className="text-ui-fg-subtle">{c.status === "scheduled" ? c.recipient_count : "—"}</Text>
                    : <Text size="small">{c.sent_count} sent{c.failed_count ? <span style={{ color: "var(--fg-error, #b91c1c)" }}> · {c.failed_count} failed</span> : null}</Text>}
                </td>
              ) : null}
              <td className="py-3"><Text size="small" className="text-ui-fg-subtle">{isTemplate ? `Edited ${fmtDate(c.updated_at)}` : when}</Text></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  const hasReceivingTemplate = templates.some((t) => t.template_role === "receiving")

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4 gap-3 flex-wrap">
        <div>
          <Heading level="h1">Marketing</Heading>
          <Text size="small" className="text-ui-fg-subtle">On-brand emails to approved customers. Each buyer sees their own prices.</Text>
        </div>
        {tab === "campaigns"
          ? <Button onClick={newCampaign} isLoading={busy}>New campaign</Button>
          : <Button onClick={() => go("/admin/marketing/templates", {})} isLoading={busy}>New template</Button>}
      </div>

      {sending && !sending.ready ? (
        <div className="px-6 py-3" style={{ background: "var(--tag-orange-bg, #fff7ed)" }}>
          <Text size="small"><strong>Sending isn't switched on yet.</strong> You can write and preview campaigns; test and send stay off until it's set up. {sending.reason}</Text>
        </div>
      ) : null}

      <div className="px-6 pt-3 flex gap-1">
        {(["campaigns", "templates"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => pickTab(t)}
            className={`px-3 py-2 txt-compact-small rounded-t-md ${tab === t ? "bg-ui-bg-base-pressed font-medium text-ui-fg-base" : "text-ui-fg-subtle"}`}
          >
            {t === "campaigns" ? `Campaigns${campaigns ? ` · ${campaigns.length}` : ""}` : `Templates · ${templates.length}`}
          </button>
        ))}
      </div>

      <div className="px-6 py-4">
        {tab === "campaigns" ? (
          <>
            {campaigns === null ? <Text size="small" className="text-ui-fg-subtle">Loading…</Text> : null}
            {campaigns?.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ui-border-strong px-6 py-10 text-center">
                <Heading level="h2">No campaigns yet</Heading>
                <Text size="small" className="text-ui-fg-subtle mt-1">Each saved receiving makes a "new arrivals" draft here automatically. Or start one yourself.</Text>
                <div className="mt-4"><Button onClick={newCampaign} isLoading={busy}>New campaign</Button></div>
              </div>
            ) : null}
            {campaigns && campaigns.length > 0 ? rowsFor(campaigns, false) : null}
          </>
        ) : (
          <>
            <div className="rounded-md bg-ui-bg-subtle px-3 py-2 mb-3">
              <Text size="small">
                {hasReceivingTemplate
                  ? "Each saved receiving makes a draft from the template marked \"Receiving announcements\", with that receiving's products filled in."
                  : "No template is marked for receivings yet, so receiving drafts use the built-in wording. Create one with New template (it starts from the built-in one) and mark it in its last step."}
              </Text>
            </div>
            {templates.length ? rowsFor(templates, true) : <Text size="small" className="text-ui-fg-subtle">No templates yet. Use New template, or "Save as template" on any campaign.</Text>}
          </>
        )}
      </div>

      {choosing ? (
        <Modal title="New campaign" subtitle="Start blank or from a template." onClose={() => setChoosing(false)}>
          <div className="flex flex-col gap-2">
            <button type="button" className="text-left rounded-md border border-ui-border-base px-3 py-3 hover:bg-ui-bg-base-hover" onClick={() => go("/admin/marketing/campaigns", {})}>
              <Text size="small" weight="plus">Blank</Text>
              <Text size="xsmall" className="text-ui-fg-subtle">Heading, text, a products block and a button to fill in.</Text>
            </button>
            {templates.map((t) => (
              <button key={t.id} type="button" className="text-left rounded-md border border-ui-border-base px-3 py-3 hover:bg-ui-bg-base-hover" onClick={() => go("/admin/marketing/campaigns", { templateId: t.id })}>
                <Text size="small" weight="plus">{t.name}</Text>
                <Text size="xsmall" className="text-ui-fg-subtle truncate">{t.subject || "No subject"}</Text>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Marketing",
  icon: MailIcon,
})

export default MarketingPage

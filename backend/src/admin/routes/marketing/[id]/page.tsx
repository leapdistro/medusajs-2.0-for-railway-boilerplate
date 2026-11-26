import { Badge, Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { api, fmtDate, STATUS_LABEL, type AudienceInfo, type Campaign, type MarketingCustomer, type Sending } from "../../../components/marketing/api"
import { AudiencePicker } from "../../../components/marketing/audience-picker"
import { BlockEditor } from "../../../components/marketing/block-editor"
import { PreviewPane } from "../../../components/marketing/preview-pane"
import { SendDialog, TestDialog } from "../../../components/marketing/send-dialogs"

/**
 * Campaign editor: subject + preview line, audience, content blocks on
 * the left; the real email, live, on the right. Drafts save themselves
 * 800ms after the last change. Sent campaigns open read-only with their
 * results.
 */

type Detail = {
  campaign: Campaign
  tallies: Record<string, number>
  failures: Array<{ email: string; error: string }>
  problems: string[]
  sending: Sending
}

const idFromPath = () => decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop() ?? "")

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-3 px-6 py-5">
    <div>
      <Heading level="h2">{title}</Heading>
      {hint ? <Text size="small" className="text-ui-fg-subtle">{hint}</Text> : null}
    </div>
    {children}
  </div>
)

const CampaignEditorPage = () => {
  const id = idFromPath()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [c, setC] = useState<Campaign | null>(null)
  const [customers, setCustomers] = useState<MarketingCustomer[]>([])
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved")
  const [problems, setProblems] = useState<string[]>([])
  const [dialog, setDialog] = useState<null | "test" | "send">(null)
  const [aud, setAud] = useState<AudienceInfo | null>(null)
  const dirty = useRef(false)

  const load = useCallback(async () => {
    try {
      const d = await api<Detail>(`/admin/marketing/campaigns/${id}`)
      setDetail(d); setC(d.campaign); setProblems(d.problems); dirty.current = false; setSaveState("saved")
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't load the campaign")
    }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api<{ customers: MarketingCustomer[] }>("/admin/marketing/customers").then((r) => setCustomers(r.customers)).catch(() => {})
  }, [])

  const editable = c?.status === "draft"

  /* Autosave drafts. */
  useEffect(() => {
    if (!c || !editable || !dirty.current) return
    setSaveState("dirty")
    const t = setTimeout(async () => {
      setSaveState("saving")
      try {
        const r = await api<{ campaign: Campaign; problems: string[] }>(`/admin/marketing/campaigns/${c.id}`, {
          body: { name: c.name, subject: c.subject, preheader: c.preheader, blocks: c.blocks, audience: c.audience },
        })
        setProblems(r.problems)
        dirty.current = false
        setSaveState("saved")
      } catch (e: any) {
        setSaveState("error")
        toast.error(e?.message ?? "Couldn't save")
      }
    }, 800)
    return () => clearTimeout(t)
  }, [c?.name, c?.subject, c?.preheader, JSON.stringify(c?.blocks), JSON.stringify(c?.audience)])

  /* Refresh while it's sending. */
  useEffect(() => {
    if (c?.status !== "sending") return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [c?.status, load])

  const edit = (patch: Partial<Campaign>) => {
    dirty.current = true
    setC((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const openSend = async () => {
    if (saveState !== "saved") { toast.info("Saving… try again in a second."); return }
    try {
      const info = await api<AudienceInfo>("/admin/marketing/audience", { body: { audience: c!.audience } })
      setAud(info); setDialog("send")
    } catch (e: any) { toast.error(e?.message ?? "Couldn't count the audience") }
  }

  const action = async (path: string, done: string, after?: (r: any) => void) => {
    try {
      const r = await api(`/admin/marketing/campaigns/${c!.id}/${path}`, { body: {} })
      toast.success(done)
      if (after) after(r); else load()
    } catch (e: any) { toast.error(e?.message ?? "That didn't work") }
  }

  const remove = async () => {
    if (!window.confirm("Delete this draft?")) return
    try {
      await api(`/admin/marketing/campaigns/${c!.id}`, { method: "DELETE" })
      window.location.href = "/app/marketing"
    } catch (e: any) { toast.error(e?.message ?? "Couldn't delete") }
  }

  if (!c || !detail) {
    return <Container><Text size="small" className="text-ui-fg-subtle">Loading…</Text></Container>
  }

  const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.draft
  const sendingReady = detail.sending.ready
  const blocked = problems.length > 0
  const src = c.source as any

  return (
    <div className="flex flex-col gap-3">
      <Container className="p-0">
        <div className="flex items-center gap-3 px-6 py-4 flex-wrap">
          <a href="/app/marketing" className="text-ui-fg-subtle txt-compact-small">← Marketing</a>
          <div style={{ flex: 1, minWidth: 240 }}>
            {editable
              ? <Input value={c.name} onChange={(e) => edit({ name: e.target.value })} aria-label="Campaign name" />
              : <Heading level="h1">{c.name}</Heading>}
          </div>
          <Badge size="small" color={st.color}>{st.label}</Badge>
          {editable ? (
            <Text size="xsmall" className="text-ui-fg-muted" style={{ width: 70 }}>
              {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Editing"}
            </Text>
          ) : null}
          {editable ? <Button variant="secondary" onClick={() => setDialog("test")} disabled={!sendingReady || blocked}>Send test</Button> : null}
          {editable ? <Button onClick={openSend} disabled={!sendingReady || blocked}>Send…</Button> : null}
          {c.status === "scheduled" ? <Button variant="secondary" onClick={() => action("cancel", "Unscheduled, back to draft")}>Unschedule</Button> : null}
          {c.status === "sending" ? <Button variant="danger" onClick={() => window.confirm("Stop sending? Emails already sent can't be recalled.") && action("cancel", "Stopped")}>Stop</Button> : null}
          <Button variant="secondary" onClick={() => action("duplicate", "Duplicated", (r) => { window.location.href = `/app/marketing/${r.campaign.id}` })}>Duplicate</Button>
          {editable || c.status === "cancelled" ? <Button variant="transparent" onClick={remove}>Delete</Button> : null}
        </div>
        {!sendingReady ? (
          <div className="px-6 py-2 border-t border-ui-border-base" style={{ background: "var(--tag-orange-bg, #fff7ed)" }}>
            <Text size="small">Test and send are off until sending is set up. {detail.sending.reason}</Text>
          </div>
        ) : null}
        {editable && blocked ? (
          <div className="px-6 py-2 border-t border-ui-border-base">
            <Text size="small" className="text-ui-fg-subtle">Before sending: {problems.join(" ")}</Text>
          </div>
        ) : null}
        {src?.type === "receiving" ? (
          <div className="px-6 py-2 border-t border-ui-border-base">
            <Text size="small" className="text-ui-fg-subtle">
              From receiving <a className="underline" href={`/app/receiving/history/${src.id}`}>{src.invoice || src.id}</a>
              {typeof src.newTotal === "number" ? `: featuring ${src.featuredNew} of ${src.newTotal} new product${src.newTotal === 1 ? "" : "s"}${src.restockTotal ? ` and ${src.featuredRestock} of ${src.restockTotal} restocked` : ""}, varied across tiers. "See all" links to the full list on the site. Swap any with Add products.` : "."}
            </Text>
          </div>
        ) : null}
        {c.status === "scheduled" ? (
          <div className="px-6 py-2 border-t border-ui-border-base">
            <Text size="small">Goes out {fmtDate(c.scheduled_at)} to about {c.recipient_count} customers (the list is fixed at that moment). Unschedule to edit.</Text>
          </div>
        ) : null}
        {c.status !== "draft" && c.status !== "scheduled" ? (
          <div className="px-6 py-3 border-t border-ui-border-base flex gap-6 flex-wrap">
            <Text size="small"><strong>{c.recipient_count}</strong> recipients</Text>
            <Text size="small"><strong>{detail.tallies.sent ?? 0}</strong> sent</Text>
            {detail.tallies.queued || detail.tallies.sending ? <Text size="small"><strong>{(detail.tallies.queued ?? 0) + (detail.tallies.sending ?? 0)}</strong> waiting</Text> : null}
            {detail.tallies.failed ? <Text size="small" style={{ color: "var(--fg-error, #b91c1c)" }}><strong>{detail.tallies.failed}</strong> failed</Text> : null}
            {detail.tallies.skipped ? <Text size="small"><strong>{detail.tallies.skipped}</strong> skipped</Text> : null}
            {c.sent_at ? <Text size="small" className="text-ui-fg-subtle">Finished {fmtDate(c.sent_at)}</Text> : c.started_at ? <Text size="small" className="text-ui-fg-subtle">Started {fmtDate(c.started_at)}</Text> : null}
            {c.last_error ? <Text size="small" style={{ color: "var(--fg-error, #b91c1c)", width: "100%" }}>{c.last_error}</Text> : null}
            {detail.failures.length ? (
              <details style={{ width: "100%" }}>
                <summary className="txt-compact-small cursor-pointer">Who didn't get it</summary>
                {detail.failures.map((f) => <Text key={f.email} size="xsmall" className="text-ui-fg-subtle">{f.email}: {f.error}</Text>)}
              </details>
            ) : null}
          </div>
        ) : null}
      </Container>

      <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(380px, 520px) minmax(0, 1fr)", alignItems: "start" }}>
        <Container className="divide-y p-0">
          <Section title="Subject" hint="What buyers see in their inbox.">
            <div className="flex flex-col gap-1">
              <Label size="xsmall" weight="plus">Subject line</Label>
              <Input value={c.subject} onChange={(e) => edit({ subject: e.target.value })} disabled={!editable} placeholder="Just landed: 12 new strains" />
              <Text size="xsmall" className="text-ui-fg-muted">{c.subject.length}/60 recommended</Text>
            </div>
            <div className="flex flex-col gap-1">
              <Label size="xsmall" weight="plus">Preview line</Label>
              <Input value={c.preheader} onChange={(e) => edit({ preheader: e.target.value })} disabled={!editable} placeholder="Ready to ship tomorrow. Lab reports on every batch." />
              <Text size="xsmall" className="text-ui-fg-muted">Shown next to the subject in most inboxes.</Text>
            </div>
          </Section>
          <Section title="Audience" hint="Approved customers only. Anyone who unsubscribed is left out automatically.">
            <AudiencePicker audience={c.audience} onChange={(audience) => edit({ audience })} customers={customers} readOnly={!editable} />
          </Section>
          <Section title="Content" hint="Pick words, products and pictures; the brand look is automatic.">
            <BlockEditor blocks={c.blocks} onChange={(blocks) => edit({ blocks })} readOnly={!editable} />
          </Section>
        </Container>

        <Container className="p-4" style={{ position: "sticky", top: 12 }}>
          <PreviewPane campaignId={c.id} subject={c.subject} preheader={c.preheader} blocks={c.blocks} customers={customers} />
        </Container>
      </div>

      {dialog === "test" ? <TestDialog campaign={c} customers={customers} onClose={() => setDialog(null)} onSent={load} /> : null}
      {dialog === "send" && aud ? (
        <SendDialog campaign={c} count={aud.count} suppressed={aud.suppressed.length} onClose={() => setDialog(null)} onDone={load} />
      ) : null}
    </div>
  )
}

export default CampaignEditorPage

import { Badge, Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { api, fmtDate, STATUS_LABEL, type AudienceInfo, type Campaign, type MarketingCustomer, type Sending } from "../../../components/marketing/api"
import { AudiencePicker } from "../../../components/marketing/audience-picker"
import { BlockEditor } from "../../../components/marketing/block-editor"
import { PreviewPane } from "../../../components/marketing/preview-pane"
import { SendDialog, TestDialog } from "../../../components/marketing/send-dialogs"
import { StepBar, type Step } from "../../../components/marketing/step-bar"

/**
 * Campaign editor in four steps with a progress bar (owner, 2026-11-25:
 * "too long on one go"): 1 Content (blocks + live preview), 2 Audience,
 * 3 Subject (with an inbox preview), 4 Review & send. Back / Continue,
 * and steps already reached on the bar can be clicked. The step is kept
 * in the URL hash so a refresh stays put. Drafts save themselves 800ms
 * after the last change. Sent / scheduled campaigns open on a read-only
 * results view.
 */

type Detail = {
  campaign: Campaign
  tallies: Record<string, number>
  failures: Array<{ email: string; error: string }>
  problems: string[]
  sending: Sending
}

const STEPS: Step[] = [
  { key: "content", label: "Content", hint: "Build the email" },
  { key: "audience", label: "Audience", hint: "Who gets it" },
  { key: "subject", label: "Subject", hint: "How it looks in the inbox" },
  { key: "review", label: "Review & send", hint: "Check, test, send" },
]

const idFromPath = () => decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop() ?? "")
const stepFromHash = () => {
  const m = /step=(\d)/.exec(window.location.hash)
  const n = m ? Number(m[1]) - 1 : 0
  return n >= 0 && n < STEPS.length ? n : 0
}

const hasWords = (c: Campaign) => c.blocks.some((b) => (b.type === "heading" || b.type === "text") && b.text.trim())

const CampaignEditorPage = () => {
  const id = idFromPath()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [c, setC] = useState<Campaign | null>(null)
  const [customers, setCustomers] = useState<MarketingCustomer[]>([])
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved")
  const [problems, setProblems] = useState<string[]>([])
  const [dialog, setDialog] = useState<null | "test" | "send">(null)
  const [aud, setAud] = useState<AudienceInfo | null>(null)
  const [step, setStepState] = useState(stepFromHash)
  const [reached, setReached] = useState(stepFromHash)
  const dirty = useRef(false)

  const setStep = (n: number) => {
    setStepState(n)
    setReached((r) => Math.max(r, n))
    try { window.history.replaceState(null, "", `#step=${n + 1}`) } catch { /* ignore */ }
    window.scrollTo({ top: 0 })
  }

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

  /* Live audience count for the Audience step's Continue and the Review step. */
  useEffect(() => {
    if (!c) return
    let cancelled = false
    const t = setTimeout(() => {
      api<AudienceInfo>("/admin/marketing/audience", { body: { audience: c.audience } }).then((r) => { if (!cancelled) setAud(r) }).catch(() => {})
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [JSON.stringify(c?.audience)])

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
  const src = c.source as any

  /* What stops each step's Continue, in words. */
  const stepBlock: Array<string | null> = [
    hasWords(c) ? null : "Add a heading or some text first.",
    aud && aud.count === 0 ? "No one matches this audience yet." : null,
    c.subject.trim() ? null : "Add a subject line.",
    null,
  ]

  const header = (
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
        {c.status === "scheduled" ? <Button variant="secondary" onClick={() => action("cancel", "Unscheduled, back to draft")}>Unschedule</Button> : null}
        {c.status === "sending" ? <Button variant="danger" onClick={() => window.confirm("Stop sending? Emails already sent can't be recalled.") && action("cancel", "Stopped")}>Stop</Button> : null}
        <Button variant="secondary" onClick={() => action("duplicate", "Duplicated", (r) => { window.location.href = `/app/marketing/${r.campaign.id}` })}>Duplicate</Button>
        {editable || c.status === "cancelled" ? <Button variant="transparent" onClick={remove}>Delete</Button> : null}
      </div>
      {editable ? (
        <div className="px-6 pb-5">
          <StepBar steps={STEPS} current={step} reached={reached} onPick={setStep} />
        </div>
      ) : null}
      {editable && src?.type === "receiving" && step === 0 ? (
        <div className="px-6 py-2 border-t border-ui-border-base">
          <Text size="small" className="text-ui-fg-subtle">
            From receiving <a className="underline" href={`/app/receiving/history/${src.id}`}>{src.invoice || src.id}</a>
            {typeof src.newTotal === "number" ? `: featuring ${src.featuredNew} of ${src.newTotal} new product${src.newTotal === 1 ? "" : "s"}${src.restockTotal ? ` and ${src.featuredRestock} of ${src.restockTotal} restocked` : ""}, varied across tiers. "See all" links to the full list on the site. Swap any with Add products.` : "."}
          </Text>
        </div>
      ) : null}
    </Container>
  )

  const nav = editable ? (
    <Container className="flex items-center gap-3 px-6 py-4">
      {step > 0 ? <Button variant="secondary" onClick={() => setStep(step - 1)}>Back</Button> : null}
      <Text size="small" className="text-ui-fg-subtle" style={{ flex: 1, textAlign: "right" }}>{stepBlock[step] ?? ""}</Text>
      {step < STEPS.length - 1 ? (
        <Button onClick={() => setStep(step + 1)} disabled={!!stepBlock[step]}>Continue to {STEPS[step + 1].label}</Button>
      ) : null}
    </Container>
  ) : null

  const preview = (
    <Container className="p-4" style={{ position: "sticky", top: 12 }}>
      <PreviewPane campaignId={c.id} subject={c.subject} preheader={c.preheader} blocks={c.blocks} customers={customers} />
    </Container>
  )

  /* ───────── Sent / scheduled / stopped: results, read-only ───────── */
  if (!editable) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <Container className="px-6 py-4 flex gap-6 flex-wrap">
          {c.status === "scheduled" ? (
            <Text size="small">Goes out {fmtDate(c.scheduled_at)} to about {c.recipient_count} customers (the list is fixed at that moment). Unschedule to edit.</Text>
          ) : (
            <>
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
            </>
          )}
        </Container>
        <div style={{ maxWidth: 760, width: "100%", margin: "0 auto" }}>{preview}</div>
      </div>
    )
  }

  /* ───────── Draft: the four steps ───────── */
  return (
    <div className="flex flex-col gap-3">
      {header}

      {step === 0 ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(380px, 520px) minmax(0, 1fr)", alignItems: "start" }}>
          <Container className="px-6 py-5 flex flex-col gap-3">
            <div>
              <Heading level="h2">Content</Heading>
              <Text size="small" className="text-ui-fg-subtle">Pick words, products and pictures; the brand look is automatic.</Text>
            </div>
            <BlockEditor blocks={c.blocks} onChange={(blocks) => edit({ blocks })} />
          </Container>
          {preview}
        </div>
      ) : null}

      {step === 1 ? (
        <Container className="px-6 py-5 flex flex-col gap-3" style={{ maxWidth: 820, width: "100%", margin: "0 auto" }}>
          <div>
            <Heading level="h2">Audience</Heading>
            <Text size="small" className="text-ui-fg-subtle">Approved customers only. Anyone who unsubscribed is left out automatically.</Text>
          </div>
          <AudiencePicker audience={c.audience} onChange={(audience) => edit({ audience })} customers={customers} />
        </Container>
      ) : null}

      {step === 2 ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(380px, 1fr) minmax(320px, 1fr)", alignItems: "start", maxWidth: 1100, width: "100%", margin: "0 auto" }}>
          <Container className="px-6 py-5 flex flex-col gap-4">
            <div>
              <Heading level="h2">Subject</Heading>
              <Text size="small" className="text-ui-fg-subtle">What buyers see in their inbox before they open it.</Text>
            </div>
            <div className="flex flex-col gap-1">
              <Label size="xsmall" weight="plus">Subject line</Label>
              <Input value={c.subject} onChange={(e) => edit({ subject: e.target.value })} placeholder="Just landed: 12 new strains" autoFocus />
              <Text size="xsmall" className={c.subject.length > 60 ? "text-ui-fg-error" : "text-ui-fg-muted"}>{c.subject.length}/60. Longer subjects get cut off on phones.</Text>
            </div>
            <div className="flex flex-col gap-1">
              <Label size="xsmall" weight="plus">Preview line</Label>
              <Input value={c.preheader} onChange={(e) => edit({ preheader: e.target.value })} placeholder="Ready to ship tomorrow. Lab reports on every batch." />
              <Text size="xsmall" className="text-ui-fg-muted">Shown after the subject in most inboxes. Optional.</Text>
            </div>
          </Container>
          <Container className="px-6 py-5">
            <Text size="xsmall" weight="plus" className="text-ui-fg-muted mb-2">IN THE INBOX</Text>
            <div className="rounded-md border border-ui-border-base">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3 px-3 py-3 border-b border-ui-border-base last:border-b-0" style={{ opacity: i === 1 ? 1 : 0.35 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 99, background: i === 1 ? "#DCE8D7" : "#e5e7eb", flex: "0 0 auto" }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="flex justify-between gap-2">
                      <Text size="small" weight="plus" className="truncate">{i === 1 ? "Mind Body Spirit" : i === 0 ? "Supplier Co." : "Your bank"}</Text>
                      <Text size="xsmall" className="text-ui-fg-muted">{i === 1 ? "9:41 AM" : "Yesterday"}</Text>
                    </div>
                    {i === 1 ? (
                      <>
                        <Text size="small" weight="plus" className="truncate">{c.subject || "Your subject line"}</Text>
                        <Text size="small" className="text-ui-fg-subtle truncate">{c.preheader || "Your preview line"}</Text>
                      </>
                    ) : (
                      <>
                        <div style={{ height: 10, width: "70%", background: "#e5e7eb", borderRadius: 4, marginTop: 6 }} />
                        <div style={{ height: 10, width: "90%", background: "#eef0f2", borderRadius: 4, marginTop: 6 }} />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Container>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(340px, 420px) minmax(0, 1fr)", alignItems: "start" }}>
          <Container className="px-6 py-5 flex flex-col gap-4">
            <div>
              <Heading level="h2">Review & send</Heading>
              <Text size="small" className="text-ui-fg-subtle">Check everything, send yourself a test, then send or schedule.</Text>
            </div>
            {[
              { label: "Content", value: `${c.blocks.length} block${c.blocks.length === 1 ? "" : "s"}, ${c.blocks.reduce((n, b) => n + (b.type === "products" ? b.productIds.length : 0), 0)} products`, step: 0 },
              { label: "Audience", value: aud ? `${aud.count} customer${aud.count === 1 ? "" : "s"}${aud.suppressed.length ? ` (${aud.suppressed.length} unsubscribed left out)` : ""}` : "Counting…", step: 1 },
              { label: "Subject", value: c.subject || "None yet", step: 2 },
              { label: "From", value: detail.sending.from ?? "Not set up yet", step: null },
              { label: "Test", value: c.last_test_at ? `Sent ${fmtDate(c.last_test_at)}` : "Not sent yet", step: null },
            ].map((r) => (
              <div key={r.label} className="flex gap-3 items-start">
                <Text size="small" className="text-ui-fg-subtle" style={{ width: 80, flex: "0 0 auto" }}>{r.label}</Text>
                <Text size="small" weight="plus" style={{ flex: 1, color: r.label === "Test" && !c.last_test_at ? "var(--fg-error, #b91c1c)" : undefined }}>{r.value}</Text>
                {r.step !== null ? <Button size="small" variant="transparent" onClick={() => setStep(r.step!)}>Edit</Button> : null}
              </div>
            ))}
            {!sendingReady ? (
              <div className="rounded-md px-3 py-2" style={{ background: "var(--tag-orange-bg, #fff7ed)" }}>
                <Text size="small">Test and send are off until sending is set up. {detail.sending.reason}</Text>
              </div>
            ) : null}
            {problems.length ? (
              <div className="rounded-md px-3 py-2" style={{ background: "var(--tag-orange-bg, #fff7ed)" }}>
                <Text size="small">Before sending: {problems.join(" ")}</Text>
              </div>
            ) : null}
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" onClick={() => setDialog("test")} disabled={!sendingReady || problems.length > 0 || saveState !== "saved"}>Send test</Button>
              <Button
                onClick={() => setDialog("send")}
                disabled={!sendingReady || problems.length > 0 || saveState !== "saved" || !aud || aud.count === 0}
              >
                Send or schedule…
              </Button>
            </div>
          </Container>
          {preview}
        </div>
      ) : null}

      {nav}

      {dialog === "test" ? <TestDialog campaign={c} customers={customers} onClose={() => setDialog(null)} onSent={load} /> : null}
      {dialog === "send" && aud ? (
        <SendDialog campaign={c} count={aud.count} suppressed={aud.suppressed.length} onClose={() => setDialog(null)} onDone={load} />
      ) : null}
    </div>
  )
}

export default CampaignEditorPage

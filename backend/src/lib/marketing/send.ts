import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MARKETING_MODULE } from "../../modules/marketing"
import { approvedContacts, resolveAudience, suppressedEmails, type Contact } from "./audience"
import { productIdsOf, sanitizeAudience, sanitizeBlocks, type Block } from "./blocks"
import { renderMarketingEmail, type EmailContact } from "./email"
import { loadEmailProducts, type EmailProduct } from "./products"
import { marketingSender, type OutgoingEmail } from "./sender"
import { unsubscribeOneClickUrl, unsubscribePageUrl, unsubscribeToken } from "./unsubscribe"

/**
 * Campaign sending.
 *
 * 1. queueCampaign: resolve the audience once and write one recipient
 *    row per address (unique per campaign), status "queued".
 * 2. processCampaign: under a lock, take queued rows 100 at a time,
 *    re-check the suppression list, mark them "sending", render each
 *    buyer's own copy (name, their prices, their unsubscribe link), send
 *    the batch, record sent / failed. A restart resumes from the queued
 *    rows. Rows left in "sending" by a crash are marked failed, never
 *    re-sent: nobody gets a campaign twice.
 * 3. The marketing-send job (every minute) starts due scheduled
 *    campaigns and resumes interrupted ones.
 */

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

const LOCK_MS = 5 * 60 * 1000
const STALE_CLAIM_MS = 10 * 60 * 1000
const iso = (ms = Date.now()) => new Date(ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Atomic claim of a campaign's send lock (one sender at a time). */
async function takeLock(scope: any, campaignId: string): Promise<boolean> {
  const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const now = iso()
  const res = await pg.raw(
    `update marketing_campaign set locked_until = ? where id = ? and deleted_at is null and (locked_until is null or locked_until < ?) returning id`,
    [iso(Date.now() + LOCK_MS), campaignId, now],
  )
  return (res?.rows ?? []).length > 0
}
async function renewLock(scope: any, campaignId: string) {
  const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  await pg.raw(`update marketing_campaign set locked_until = ? where id = ?`, [iso(Date.now() + LOCK_MS), campaignId])
}
async function releaseLock(scope: any, campaignId: string) {
  const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  await pg.raw(`update marketing_campaign set locked_until = null where id = ?`, [campaignId])
}

/** One buyer's copy (also used for test sends). */
export async function renderForContact(
  campaign: { id: string; subject: string; preheader: string; blocks: Block[] },
  products: Map<string, EmailProduct>,
  contact: (EmailContact & { email?: string }) | null,
  email: string | null,
) {
  const token = email ? unsubscribeToken(email, campaign.id) : null
  const { html, text } = await renderMarketingEmail({
    campaignId: campaign.id,
    subject: campaign.subject,
    preheader: campaign.preheader,
    blocks: campaign.blocks,
    products,
    contact,
    unsubscribeUrl: token ? unsubscribePageUrl(token) : null,
  })
  const headers: Record<string, string> = {}
  if (token) {
    /* Gmail / Yahoo bulk-sender rule: one-click unsubscribe (RFC 8058). */
    headers["List-Unsubscribe"] = `<${unsubscribeOneClickUrl(token)}>`
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
  }
  return { html, text, headers }
}

/** Fixes the recipient list. Returns how many were queued. */
export async function queueCampaign(scope: any, campaignId: string): Promise<{ queued: number; suppressed: number }> {
  const marketing: any = scope.resolve(MARKETING_MODULE)
  const campaign = await marketing.retrieveMarketingCampaign(campaignId)
  const { recipients, suppressed } = await resolveAudience(scope, sanitizeAudience(campaign.audience))
  const existing = new Set(
    ((await marketing.listMarketingRecipients({ campaign_id: campaignId }, { take: 100000, select: ["email"] })) as any[]).map((r) => r.email),
  )
  const rows = recipients.filter((c) => !existing.has(c.email)).map((c) => ({
    campaign_id: campaignId, customer_id: c.customerId, email: c.email, status: "queued",
  }))
  for (let i = 0; i < rows.length; i += 500) await marketing.createMarketingRecipients(rows.slice(i, i + 500))
  const total = existing.size + rows.length
  await marketing.updateMarketingCampaigns({
    id: campaignId, status: "sending", started_at: campaign.started_at ?? iso(), recipient_count: total, last_error: null,
  })
  return { queued: rows.length, suppressed: suppressed.length }
}

export async function processCampaign(scope: any, campaignId: string, log: Log): Promise<void> {
  if (!(await takeLock(scope, campaignId))) return
  const marketing: any = scope.resolve(MARKETING_MODULE)
  try {
    const campaign = await marketing.retrieveMarketingCampaign(campaignId)
    if (campaign.status !== "sending") return
    const sender = marketingSender()
    if (!sender) {
      await marketing.updateMarketingCampaigns({ id: campaignId, last_error: "Marketing sending isn't set up (MARKETING_FROM_EMAIL / API key)." })
      return
    }
    const blocks = sanitizeBlocks(campaign.blocks)
    const content = { id: campaign.id, subject: campaign.subject, preheader: campaign.preheader, blocks }
    const productIds = productIdsOf(blocks)

    /* Interrupted claims: never re-send, mark them failed. */
    const stale = (await marketing.listMarketingRecipients({ campaign_id: campaignId, status: "sending" }, { take: 100000 })) as any[]
    const staleCut = Date.now() - STALE_CLAIM_MS
    const staleRows = stale.filter((r) => new Date(r.updated_at).getTime() < staleCut)
    if (staleRows.length) {
      await marketing.updateMarketingRecipients(staleRows.map((r) => ({ id: r.id, status: "failed", error: "Interrupted while sending; not re-sent to avoid a duplicate." })))
    }

    const contacts = new Map<string, Contact>((await approvedContacts(scope)).map((c) => [c.customerId, c]))
    const productCache = new Map<string, Map<string, EmailProduct>>()
    const productsFor = async (groupIds: string[]) => {
      const key = groupIds.join(",")
      if (!productCache.has(key)) productCache.set(key, await loadEmailProducts(scope, productIds, groupIds))
      return productCache.get(key)!
    }

    for (;;) {
      /* Stopped from admin (Cancel) → leave the rest. */
      const current = await marketing.retrieveMarketingCampaign(campaignId)
      if (current.status !== "sending") return
      const batch = (await marketing.listMarketingRecipients(
        { campaign_id: campaignId, status: "queued" },
        { take: sender.maxBatch, order: { created_at: "ASC" } },
      )) as any[]
      if (!batch.length) break
      await renewLock(scope, campaignId)

      const suppressed = await suppressedEmails(scope)
      const skip = batch.filter((r) => suppressed.has(r.email))
      if (skip.length) {
        await marketing.updateMarketingRecipients(skip.map((r) => ({ id: r.id, status: "skipped", error: `On the suppression list (${suppressed.get(r.email)})` })))
      }
      const go = batch.filter((r) => !suppressed.has(r.email))
      if (!go.length) continue
      await marketing.updateMarketingRecipients(go.map((r) => ({ id: r.id, status: "sending" })))

      const emails: OutgoingEmail[] = []
      for (const r of go) {
        const c = r.customer_id ? contacts.get(r.customer_id) : undefined
        const products = await productsFor(c?.groupIds ?? [])
        const { html, text, headers } = await renderForContact(content, products, c ? { firstName: c.firstName, company: c.company } : null, r.email)
        emails.push({
          to: r.email,
          subject: campaign.subject,
          html, text, headers,
          tags: [{ name: "campaign", value: campaignId.replace(/[^A-Za-z0-9_-]/g, "_") }],
        })
      }
      const results = await sender.sendBatch(emails)
      const at = iso()
      await marketing.updateMarketingRecipients(go.map((r, i) => ({
        id: r.id,
        status: results[i]?.id ? "sent" : "failed",
        message_id: results[i]?.id ?? null,
        error: results[i]?.error ?? null,
        sent_at: results[i]?.id ? at : null,
      })))
      const sent = results.filter((x) => x.id).length
      const failed = results.length - sent
      const fresh = await marketing.retrieveMarketingCampaign(campaignId)
      await marketing.updateMarketingCampaigns({
        id: campaignId,
        sent_count: (fresh.sent_count ?? 0) + sent,
        failed_count: (fresh.failed_count ?? 0) + failed,
        ...(failed ? { last_error: results.find((x) => x.error)?.error ?? null } : {}),
      })
      log.info(`[marketing] ${campaignId}: batch of ${go.length} → ${sent} sent, ${failed} failed`)
      /* Every send in a batch failing the same way = stop, don't burn the list. */
      if (sent === 0 && failed > 0) {
        await marketing.updateMarketingCampaigns({ id: campaignId, status: "failed", last_error: results[0]?.error ?? "Sending failed" })
        log.warn(`[marketing] ${campaignId}: stopped, whole batch failed: ${results[0]?.error}`)
        return
      }
      await sleep(sender.pauseMs)
    }

    const remaining = (await marketing.listMarketingRecipients({ campaign_id: campaignId, status: ["queued", "sending"] }, { take: 1 })) as any[]
    if (!remaining.length) {
      await marketing.updateMarketingCampaigns({ id: campaignId, status: "sent", sent_at: iso() })
      log.info(`[marketing] ${campaignId}: done`)
    }
  } catch (e: any) {
    log.error(`[marketing] ${campaignId}: ${e?.message ?? e}`)
    await marketing.updateMarketingCampaigns({ id: campaignId, last_error: String(e?.message ?? e).slice(0, 500) }).catch(() => {})
  } finally {
    await releaseLock(scope, campaignId).catch(() => {})
  }
}

/** The job's pass: start due scheduled campaigns, resume sending ones. */
export async function runMarketingQueue(scope: any, log: Log): Promise<number> {
  const marketing: any = scope.resolve(MARKETING_MODULE)
  const now = iso()
  const due = ((await marketing.listMarketingCampaigns({ status: "scheduled" }, { take: 50 })) as any[])
    .filter((c) => c.scheduled_at && c.scheduled_at <= now)
  for (const c of due) {
    await queueCampaign(scope, c.id)
    log.info(`[marketing] ${c.id}: scheduled time reached, queued`)
  }
  const sending = (await marketing.listMarketingCampaigns({ status: "sending" }, { take: 50 })) as any[]
  for (const c of sending) await processCampaign(scope, c.id, log)
  return due.length + sending.length
}

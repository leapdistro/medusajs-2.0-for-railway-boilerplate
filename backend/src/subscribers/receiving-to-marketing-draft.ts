import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { sendFeedNotification } from "../lib/feed-notification"
import { upsertReceivingDraft } from "../lib/marketing/campaigns"

/**
 * After a receiving saves: make (or refresh) its "new arrivals" email
 * draft from the receiving template and say so on the admin bell
 * (owner, 2026-11-25). Never sends: the admin opens Marketing, checks,
 * and sends. A draft the admin already edited is left alone.
 */
export default async function receivingToMarketingDraft({ event: { data }, container }: SubscriberArgs<{ history_id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const historyId = data?.history_id
  if (!historyId) return
  try {
    const r: any = await upsertReceivingDraft(container, historyId, { auto: true })
    if (!r.campaign || (!r.created && !r.refreshed)) return
    const s = r.campaign.source ?? {}
    const featured = (s.featuredNew ?? 0) + (s.featuredRestock ?? 0)
    const what = s.newTotal ? `${s.featuredNew} of ${s.newTotal} new products` : `${featured} of ${s.restockTotal} restocked products`
    await sendFeedNotification(container, {
      title: r.created ? "New arrivals email ready to review" : "New arrivals email updated",
      description: `Receiving ${s.invoice ?? historyId}: draft "${r.campaign.subject}" featuring ${what}. Open Marketing to check and send. Nothing has been sent.`,
    })
  } catch (e: any) {
    logger.warn(`[receiving-to-marketing-draft] ${historyId}: ${e?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: "receiving.saved",
}

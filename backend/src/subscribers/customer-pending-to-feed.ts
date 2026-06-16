import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { sendFeedNotification } from "../lib/feed-notification"

/**
 * When a buyer edits their /account profile, business, or address,
 * the storefront flag-stamps customer.metadata.qbo_sync_pending = true.
 * This subscriber listens for the resulting customer.updated event and
 * dispatches a bell notification once per pending period so the
 * operator notices without polling the customer list.
 *
 * Dedup strategy: store qbo_pending_notified_at on the customer's
 * metadata. Fire only when:
 *   - qbo_sync_pending === true
 *   - qbo_pending_notified_at is missing OR older than qbo_sync_pending_at
 *
 * Then stamp qbo_pending_notified_at = qbo_sync_pending_at. This caps
 * the bell to one entry per pending period (one buyer edit cluster).
 * When the operator clicks Push Updates to QBO, the route clears
 * qbo_sync_pending — the next /account edit will re-stamp pending_at
 * later, triggering a fresh bell ping.
 *
 * Filters out operator-driven customer.updated events (Approve & Welcome,
 * pricing-mode toggle, etc.) naturally — those don't flip qbo_sync_pending
 * to true, so the gate at the top never opens.
 */
export default async function customerPendingToFeedHandler({
  event,
  container,
}: SubscriberArgs<{ id?: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = event?.data?.id
  if (!customerId) return

  let customerService: any
  try {
    customerService = container.resolve(Modules.CUSTOMER)
  } catch {
    return
  }

  const [customer] = await customerService.listCustomers(
    { id: [String(customerId)] },
    { take: 1 },
  ).catch(() => [])
  if (!customer) return

  const meta = (customer.metadata ?? {}) as Record<string, any>
  if (meta.qbo_sync_pending !== true) return

  const pendingAt = typeof meta.qbo_sync_pending_at === "string" ? meta.qbo_sync_pending_at : null
  const notifiedAt = typeof meta.qbo_pending_notified_at === "string" ? meta.qbo_pending_notified_at : null
  /* Dedup: skip when we've already notified for this exact pending period.
   * String comparison is sufficient because both values are ISO timestamps
   * stored in lexicographically-orderable form. */
  if (pendingAt && notifiedAt && pendingAt <= notifiedAt) return

  const businessName = (customer.company_name as string | null)
    ?? (meta.business_name as string | undefined)
    ?? null
  const displayName = [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim()
    || businessName
    || customer.email
  await sendFeedNotification(container, {
    title: `Buyer updated profile: ${displayName}`,
    description:
      `${customer.email}\n` +
      (businessName ? `${businessName}\n` : "") +
      `Open: /app/customers/${customer.id} — Push Updates to QBO when ready.`,
  })

  /* Stamp notified_at so subsequent customer.updated events for the
   * same pending period don't re-fire the bell. Subscriber re-entry
   * is safe because this metadata write triggers ANOTHER customer.updated
   * event — but on re-entry qbo_pending_notified_at now equals
   * qbo_sync_pending_at and the dedup gate blocks. */
  try {
    await customerService.updateCustomers(customer.id, {
      metadata: { ...meta, qbo_pending_notified_at: pendingAt ?? new Date().toISOString() },
    })
  } catch (e: any) {
    logger.warn(`[customer-pending-to-feed] couldn't stamp notified_at: ${e?.message}`)
  }
}

export const config: SubscriberConfig = {
  event: "customer.updated",
}

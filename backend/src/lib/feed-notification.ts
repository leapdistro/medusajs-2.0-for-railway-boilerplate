import { Modules } from "@medusajs/framework/utils"

/**
 * Dispatch a notification to the admin header bell (the "feed" channel).
 * The Medusa v2 dashboard reads `data.title` + `data.description` only —
 * no native click-through URL field, so encode any record id you want
 * the operator to look up into the description text.
 *
 * Safe to call from any context where the awilix container is reachable
 * (subscribers, API routes, workflows). All errors are swallowed —
 * the bell is informational, never load-bearing. A failed notification
 * shouldn't block the actual action it's summarising.
 *
 * `to` is informational only for feed notifications — Medusa's dashboard
 * lists feed-channel entries without a per-user filter, so every signed-in
 * operator sees every feed entry regardless of this value. Setting it
 * to "admin" makes raw DB inspection legible.
 */
export async function sendFeedNotification(
  container: any,
  args: {
    title: string
    description?: string
    /** Optional file attachment rendered by the bell row. */
    file?: { filename?: string; url?: string; mimeType?: string }
  },
): Promise<void> {
  try {
    const notificationService: any = container.resolve(Modules.NOTIFICATION)
    await notificationService.createNotifications([{
      to: "admin",
      channel: "feed",
      template: "feed",
      data: {
        title: args.title,
        description: args.description,
        ...(args.file ? { file: args.file } : {}),
      },
    }])
  } catch (e: any) {
    /* Avoid bubbling up — bell entries are nice-to-have, not critical. */
    try {
      const logger: any = container.resolve("logger")
      logger?.warn?.(`[feed-notification] dispatch failed: ${e?.message}`)
    } catch {
      /* If we can't even resolve the logger, swallow silently. */
    }
  }
}

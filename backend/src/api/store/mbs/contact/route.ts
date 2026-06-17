import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { sendFeedNotification } from "../../../../lib/feed-notification"

/**
 * POST /store/mbs/contact
 *
 * Body (JSON):
 *   { name, email, phone?, company?, subject, message }
 *
 * Validates, sends two emails (team alert + sender auto-reply), and
 * fires an admin bell notification.
 *
 * Auth: gated by publishable API key like the rest of /store/mbs/*.
 * Bot protection lives upstream at the storefront proxy /api/contact.
 * Email send is best-effort — logs but doesn't error the response if
 * Resend hiccups, so the sender still sees the success state on the
 * storefront.
 */

const NOTIFICATION_TO = "wholesale@hempmbs.com"

const SUBJECT_WHITELIST = new Set([
  "Wholesale inquiry",
  "COA / lab question",
  "Order help",
  "Press / media",
  "Other",
])

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const body = (req.body ?? {}) as {
    name?: string
    email?: string
    phone?: string
    company?: string
    subject?: string
    message?: string
  }

  /* Trim every string + lowercase the email. Same hygiene as
   * sign-in + apply form so case-mismatch doesn't bounce
   * legit submissions. */
  const name    = String(body.name    ?? "").trim()
  const email   = String(body.email   ?? "").trim().toLowerCase()
  const phone   = String(body.phone   ?? "").trim() || null
  const company = String(body.company ?? "").trim() || null
  const subject = String(body.subject ?? "").trim()
  const message = String(body.message ?? "").trim()

  const missing: string[] = []
  if (!name)    missing.push("name")
  if (!email)   missing.push("email")
  if (!subject) missing.push("subject")
  if (!message) missing.push("message")
  if (missing.length > 0) {
    return res.status(400).json({ ok: false, message: `Missing required: ${missing.join(", ")}` })
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, message: "Email format invalid" })
  }
  if (!SUBJECT_WHITELIST.has(subject)) {
    /* Don't expose the allowed list — bots use 400 messages as oracles.
     * Real form picks from a fixed <select> so legit submissions can't
     * land here. */
    return res.status(400).json({ ok: false, message: "Invalid subject" })
  }
  if (message.length < 10) {
    return res.status(400).json({ ok: false, message: "Message is too short — please share a bit more so we can help." })
  }
  if (message.length > 5000) {
    return res.status(400).json({ ok: false, message: "Message is too long — please shorten to under 5000 characters." })
  }

  /* Send the two emails — best-effort. We log + still 200 on Resend
   * failure so the sender's "Sent ✓" UI doesn't lie about the
   * downstream state of our mail provider. The bell notification
   * (below) is the actual operator signal; email is a courtesy. */
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (resendFrom) {
    try {
      const notificationService: any = req.scope.resolve(Modules.NOTIFICATION)
      /* Team alert. Reply-To set to the sender's email so the operator
       * clicks "Reply" in Gmail / Outlook and lands a draft addressed
       * to the actual sender, not the wholesale@ mailbox itself. */
      await notificationService.createNotifications([{
        to: NOTIFICATION_TO,
        channel: "email",
        template: "contact-team",
        from: resendFrom,
        data: {
          emailOptions: {
            subject: `Contact form: ${subject} — ${name}`,
            replyTo: email,
          },
          subject, name, email, phone, company, message,
        },
      }])
      /* Auto-reply confirmation to the sender. */
      await notificationService.createNotifications([{
        to: email,
        channel: "email",
        template: "contact-applicant",
        from: resendFrom,
        data: {
          emailOptions: {
            subject: "We got your message — Mind Body Spirit",
          },
          name, subject,
        },
      }])
    } catch (e: any) {
      logger.warn(`[/store/mbs/contact] email send failed (non-fatal): ${e?.message}`)
    }
  } else {
    logger.info(
      `[/store/mbs/contact] emails skipped — RESEND_FROM_EMAIL not set. Contact: ${subject} from ${name} <${email}>${company ? ` (${company})` : ""}: ${message.slice(0, 200)}`,
    )
  }

  /* Admin bell — fires regardless of Resend config. Encodes contact
   * details into description text so the operator sees who to reply to
   * without needing to dig into Gmail. */
  await sendFeedNotification(req.scope, {
    title: `New contact: ${subject}`,
    description:
      `${name} <${email}>\n` +
      (company ? `${company}\n` : "") +
      (phone ? `${phone}\n` : "") +
      `\n${message.slice(0, 300)}${message.length > 300 ? "…" : ""}`,
  })

  return res.json({ ok: true })
}

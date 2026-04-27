import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../../modules/mbs-settings"

/**
 * POST /admin/customers/:id/deny-application
 *
 * Body: { reasonId: string, operatorNote?: string }
 *
 * Resolves the reason label from mbs-settings.denial_reasons (operator
 * can edit/add new reasons in admin → MBS Settings without redeploying),
 * stamps the customer's metadata with denial state, and emails the
 * applicant the branded denial email via Resend.
 *
 * Idempotent-ish: re-running with the same reason just updates the
 * timestamp + re-sends. The operator can use that as a "resend" path
 * if the first email bounced; otherwise expect them to use it once.
 *
 * Wired to the customer-deny-application admin widget on the customer
 * detail page.
 */

type DenyBody = {
  reasonId?: string
  operatorNote?: string
}

type Reason = { id: string; label: string; archived?: boolean }
type ContactInfo = { support_email?: string; support_phone?: string; hours?: string }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const body = (req.body ?? {}) as DenyBody
  if (!body.reasonId) {
    return res.status(400).json({ ok: false, message: "reasonId is required" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)

  /* Resolve the denial reason against current settings — protects
   * against an admin client sending a reasonId that's been removed
   * since the page loaded. */
  const reasons = ((await settings.getSetting("denial_reasons", [])) ?? []) as Reason[]
  const reason = reasons.find((r) => r.id === body.reasonId && !r.archived)
  if (!reason) {
    return res.status(400).json({
      ok: false,
      message: `Unknown or archived reason "${body.reasonId}". Refresh and pick again.`,
    })
  }

  /* Pull contact info for the email footer. Falls back to a sensible
   * default so the email never sends without a way to reach us. */
  const contact = ((await settings.getSetting("contact_info", {})) ?? {}) as ContactInfo
  const contactEmail = contact.support_email?.trim() || "wholesale@hempmbs.com"
  const contactPhone = contact.support_phone?.trim() || undefined

  // Fetch customer for email + name + business name from metadata.
  let customer: { id: string; email: string; first_name?: string | null; last_name?: string | null; metadata?: Record<string, any> | null }
  try {
    const list = await customerService.listCustomers({ id: [customerId] }, { take: 1 })
    customer = list?.[0]
    if (!customer) return res.status(404).json({ ok: false, message: "Customer not found" })
  } catch (e: any) {
    logger.warn(`[deny-application] could not load customer ${customerId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not load customer" })
  }

  if (!customer.email || !customer.email.includes("@")) {
    return res.status(400).json({ ok: false, message: "Customer has no valid email" })
  }

  const meta = (customer.metadata ?? {}) as Record<string, any>
  const contactName =
    [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() ||
    (typeof meta.contact_name === "string" ? meta.contact_name : "") ||
    customer.email
  const businessName =
    (typeof meta.business_name === "string" ? meta.business_name : "") ||
    (typeof meta.businessName === "string" ? meta.businessName : "") ||
    undefined

  // Stamp denial metadata. Keeps existing keys intact.
  const deniedAt = new Date().toISOString()
  try {
    await customerService.updateCustomers(customer.id, {
      metadata: {
        ...meta,
        application_status: "denied",
        denied_at: deniedAt,
        denial_reason_id: reason.id,
        denial_reason_label: reason.label,
        denial_operator_note: body.operatorNote?.trim() || null,
      },
    })
  } catch (e: any) {
    logger.warn(`[deny-application] could not stamp metadata: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not save denial state" })
  }

  // Send the email (best-effort — failure surfaces but state is already saved).
  const resendKey  = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendKey || !resendFrom) {
    logger.info(`[deny-application] email skipped — RESEND env not set. Denied ${customer.email} for "${reason.label}".`)
    return res.json({ ok: true, email: customer.email, deniedAt, emailSent: false, message: "Saved denial — email skipped (no Resend env)." })
  }

  try {
    const notificationService: any = req.scope.resolve(Modules.NOTIFICATION)
    await notificationService.createNotifications([{
      to: customer.email,
      channel: "email",
      template: "application-denied",
      from: resendFrom,
      data: {
        emailOptions: {
          subject: "About your Mind Body Spirit wholesale application",
        },
        contactName,
        businessName,
        reasonLabel: reason.label,
        operatorNote: body.operatorNote?.trim() || undefined,
        contactEmail,
        contactPhone,
      },
    }])
  } catch (e: any) {
    logger.warn(`[deny-application] email send failed for ${customer.email}: ${e?.message}`)
    return res.status(500).json({
      ok: false,
      email: customer.email,
      deniedAt,
      emailSent: false,
      message: `Saved denial state but email failed: ${e?.message}`,
    })
  }

  logger.info(`[deny-application] denied ${customer.email} (reason=${reason.id})`)
  return res.json({ ok: true, email: customer.email, deniedAt, emailSent: true })
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

const APPROVED_GROUP_NAME = (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

/**
 * POST /admin/customers/:id/approve-and-welcome
 *
 * Admin-triggered: ensures the customer is in the "approved" customer group
 * (idempotent — if already there, just resends the welcome) and triggers
 * Medusa's reset-password flow with `context.isWelcome=true`. The
 * password-reset subscriber catches the resulting auth.password_reset event
 * and emails the customer the welcome / set-password link.
 *
 * Stamps `customer.metadata.welcomed_at` so the admin widget can render a
 * "Last sent" timestamp + flip its label between "Approve & Send Welcome"
 * and "Resend Welcome Email".
 *
 * Replaces the customer-group.customers_attached event subscription that
 * never fired — admin UI's group-add operation doesn't emit a high-level
 * event, so we expose this explicit endpoint instead. Wired to a custom
 * widget button on the customer detail page.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)

  // Pull the customer with their groups so we can check membership.
  let customer: { id: string; email: string; metadata?: Record<string, any> | null; groups?: Array<{ id: string; name: string }> }
  try {
    const list = await customerService.listCustomers(
      { id: [customerId] },
      { take: 1, relations: ["groups"] }
    )
    customer = list?.[0]
    if (!customer) return res.status(404).json({ ok: false, message: "Customer not found" })
  } catch (e: any) {
    logger.warn(`[approve-and-welcome] could not load customer ${customerId}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not load customer" })
  }

  if (!customer.email || !customer.email.includes("@")) {
    return res.status(400).json({ ok: false, message: "Customer has no valid email" })
  }

  // Ensure customer is in the "approved" group.
  const inApproved = (customer.groups ?? []).some(
    (g) => String(g?.name ?? "").toLowerCase() === APPROVED_GROUP_NAME
  )
  let groupAttached = false
  if (!inApproved) {
    try {
      // Find the approved group by name.
      const groups = await customerService.listCustomerGroups({ name: [APPROVED_GROUP_NAME] }, { take: 1 })
      const approvedGroup = groups?.[0]
      if (!approvedGroup) {
        return res.status(500).json({
          ok: false,
          message: `No customer group named "${APPROVED_GROUP_NAME}" exists. Create it in Customer Groups first.`,
        })
      }
      // Attach via the link table.
      await customerService.addCustomerToGroup({ customer_id: customer.id, customer_group_id: approvedGroup.id })
      groupAttached = true
      logger.info(`[approve-and-welcome] attached customer ${customer.email} to "${APPROVED_GROUP_NAME}" group`)
    } catch (e: any) {
      logger.warn(`[approve-and-welcome] could not attach group: ${e?.message}`)
      return res.status(500).json({ ok: false, message: `Could not add to "${APPROVED_GROUP_NAME}" group: ${e?.message ?? "unknown error"}` })
    }
  }

  // Set a `pending_welcome=true` flag on the customer's metadata BEFORE
  // calling reset. The password-reset subscriber will read this flag to
  // know this is a welcome (vs a normal /auth/forgot reset) and clear it
  // after sending. We use metadata as the channel because Medusa's
  // reset-password endpoint doesn't accept arbitrary context fields.
  const welcomedAt = new Date().toISOString()
  try {
    await customerService.updateCustomers(customer.id, {
      metadata: {
        ...(customer.metadata ?? {}),
        pending_welcome: true,
        welcomed_at: welcomedAt,
        application_status: "approved",
      },
    })
  } catch (e: any) {
    logger.warn(`[approve-and-welcome] could not stamp pending_welcome metadata: ${e?.message}`)
    return res.status(500).json({ ok: false, message: "Could not flag pending welcome", groupAttached })
  }

  // Trigger Medusa's reset-password flow. Server-to-server call; needs the
  // store publishable key. MEDUSA_PUBLISHABLE_API_KEY must be set on
  // Railway (same value as the storefront's NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY).
  const baseUrl = process.env.MEDUSA_BACKEND_URL || `http://localhost:${process.env.PORT || 9000}`
  const publishableKey = process.env.MEDUSA_PUBLISHABLE_API_KEY
  if (!publishableKey) {
    return res.status(500).json({
      ok: false,
      message: "MEDUSA_PUBLISHABLE_API_KEY env var is not set on the backend. Add it on Railway (same value as storefront's NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY).",
      groupAttached,
    })
  }

  try {
    const resetRes = await fetch(`${baseUrl}/auth/customer/emailpass/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": publishableKey,
      },
      body: JSON.stringify({ identifier: customer.email }),
    })
    if (!resetRes.ok) {
      const body = await resetRes.text().catch(() => "")
      logger.warn(`[approve-and-welcome] reset-password failed for ${customer.email} (${resetRes.status}): ${body.slice(0, 200)}`)
      return res.status(500).json({
        ok: false,
        message: `Could not trigger welcome email: ${resetRes.status} ${body.slice(0, 100)}`,
        groupAttached,
      })
    }
  } catch (e: any) {
    logger.warn(`[approve-and-welcome] reset-password threw for ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: `Could not trigger welcome email: ${e?.message}`, groupAttached })
  }

  logger.info(`[approve-and-welcome] success: ${customer.email} (groupAttached=${groupAttached})`)
  return res.json({
    ok: true,
    email: customer.email,
    groupAttached,
    welcomedAt,
  })
}

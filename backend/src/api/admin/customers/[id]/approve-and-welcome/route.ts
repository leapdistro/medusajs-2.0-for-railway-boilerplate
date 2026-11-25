import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { issueAccountLink } from "../../../../../lib/account-link"
import { pushCustomerToQbo } from "../../../../../lib/customer-to-qbo"

const APPROVED_GROUP_NAME = (process.env.APPROVED_GROUP_NAME || "approved").toLowerCase()

/**
 * POST /admin/customers/:id/approve-and-welcome
 *
 * Admin-triggered: ensures the customer is in the "approved" customer group
 * (idempotent — if already there, just resends the welcome) and emails a
 * set-password link (lib/account-link.ts: 7 days, single use; sending a
 * new one cancels the older link).
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
  let customer: {
    id: string; email: string; phone?: string | null;
    first_name?: string | null; last_name?: string | null;
    metadata?: Record<string, any> | null;
    groups?: Array<{ id: string; name: string }>
  }
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

  // Issue the welcome (activation) link: 7 days, single use, replaces any
  // older link. Stamps welcomed_at / application_status in the same write.
  // Replaces Medusa's reset-password flow, whose token expires in 15 min.
  const welcomedAt = new Date().toISOString()
  let link: Awaited<ReturnType<typeof issueAccountLink>>
  try {
    link = await issueAccountLink(req.scope, customer, "activation", {
      welcomed_at: welcomedAt,
      application_status: "approved",
    })
  } catch (e: any) {
    logger.warn(`[approve-and-welcome] could not create welcome link for ${customer.email}: ${e?.message}`)
    return res.status(500).json({ ok: false, message: `Could not create the welcome link: ${e?.message ?? "unknown error"}`, groupAttached })
  }
  if (!link.emailSent) {
    return res.status(500).json({
      ok: false,
      message: `${groupAttached ? "Approved, but the" : "The"} welcome email didn't send: ${link.emailError ?? "unknown error"}`,
      groupAttached,
    })
  }

  /* QBO Customer push — non-blocking. If QBO isn't configured, the
   * connection is dead, or the API errors out, we still report
   * approval success. The lib stamps qbo_push_error on metadata so
   * the admin widget can render a persistent error state + "Retry QBO
   * Push" button (no welcome re-send) across page reloads. */
  const qboResult = await pushCustomerToQbo(req.scope, customer, logger).catch((e) => ({
    state: "error" as const,
    message: e?.message ?? String(e),
  }))

  logger.info(`[approve-and-welcome] success: ${customer.email} (groupAttached=${groupAttached}, qbo=${qboResult.state})`)
  return res.json({
    ok: true,
    email: customer.email,
    groupAttached,
    welcomedAt,
    linkExpiresAt: link.expiresAt,
    qbo: qboResult,
  })
}


import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateQboCustomer } from "../../../../../lib/qbo-api"
import { pushCustomerToQbo } from "../../../../../lib/customer-to-qbo"
import { QBO_CONNECTION_MODULE } from "../../../../../modules/qbo-connection"

/**
 * POST /admin/customers/:id/push-qbo-updates
 *
 * Operator-initiated push of buyer-side profile/business/address changes
 * to the linked QBO Customer record. Sparse update — only the fields
 * we manage get overwritten; manual operator edits on other QBO fields
 * survive.
 *
 * Required state on the Medusa customer:
 *   - metadata.qbo_customer_id (already linked to a QBO Customer)
 *
 * Optional state (controls the pending UI):
 *   - metadata.qbo_sync_pending (button shows in admin when truthy)
 *
 * On success:
 *   - clears qbo_sync_pending + qbo_sync_pending_at
 *   - stamps qbo_last_synced_at
 *
 * Returns 4xx with a clear message when prerequisites are missing so
 * the operator gets actionable feedback in the admin toast.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const customerId = req.params.id
  if (!customerId) {
    return res.status(400).json({ ok: false, message: "Missing customer id" })
  }

  /* QBO connection — match the pattern in lib/qbo-order-push.ts so the
   * "not connected" error reads identically across surfaces. */
  let qbo: any
  try {
    qbo = req.scope.resolve(QBO_CONNECTION_MODULE)
  } catch {
    return res.status(400).json({ ok: false, message: "QBO module not registered" })
  }
  const connRows = await qbo.listQboConnections({}, { take: 1 }).catch(() => [])
  const conn = connRows[0]
  if (!conn) {
    return res.status(400).json({ ok: false, message: "QBO is not connected — visit /app/quickbooks first" })
  }

  /* Load the customer with the address book — we push the default
   * billing address to QBO. Falls back to the first address when no
   * default is marked. */
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService.listCustomers(
    { id: [customerId] },
    { take: 1, relations: ["addresses"] },
  ).catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  const meta = (customer.metadata ?? {}) as Record<string, any>
  const qboCustomerId = typeof meta.qbo_customer_id === "string" ? meta.qbo_customer_id : null

  /* No QBO link yet → find-or-create via the shared push lib (same
   * code path as approve-and-welcome). pushCustomerToQbo stamps
   * qbo_customer_id + qbo_pushed_at on success, and clears any prior
   * qbo_push_error. Then clear the pending flag and return. */
  if (!qboCustomerId) {
    const outcome = await pushCustomerToQbo(req.scope, customer, {
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      error: (m) => logger.error(m),
    }).catch((e) => ({ state: "error" as const, message: e?.message ?? String(e) }))

    if (outcome.state === "skipped") {
      return res.status(400).json({ ok: false, message: outcome.reason })
    }
    if (outcome.state === "error") {
      return res.status(502).json({ ok: false, message: outcome.message })
    }

    /* Re-read customer metadata — pushCustomerToQbo updated it
     * (stamped qbo_customer_id etc.); clear the pending flag on top. */
    const [refreshed] = await customerService.listCustomers({ id: [customer.id] }, { take: 1 })
    const freshMeta = (refreshed?.metadata ?? {}) as Record<string, any>
    await customerService.updateCustomers(customer.id, {
      metadata: {
        ...freshMeta,
        qbo_sync_pending: false,
        qbo_sync_pending_at: null,
        qbo_last_synced_at: new Date().toISOString(),
      },
    })
    return res.json({
      ok: true,
      qboCustomerId: outcome.qboCustomerId,
      created: outcome.created,
    })
  }

  /* Resolve the address to push. is_default_billing takes priority;
   * fall back to address_1-bearing first address; finally null. */
  const addresses = (customer.addresses ?? []) as any[]
  const billing = addresses.find((a) => a?.is_default_billing) ?? addresses.find((a) => a?.address_1) ?? null

  /* Business type label — same lookup as findOrCreateCustomer. The
   * apply form stores a slug; admin Settings has a label map. We pass
   * the slug through unchanged if the label can't be resolved cheaply;
   * QBO Notes shows "Business Type: smoke_shop" instead of "Smoke Shop"
   * which is still readable. */
  const businessTypeLabel = typeof meta.business_type === "string" ? meta.business_type : null

  /* Business name fallback ladder — first non-empty:
   *   1. customer.company_name (first-class field, edited in /account profile)
   *   2. metadata.business_name (set by apply form)
   *   3. customer.email (last resort — QBO requires DisplayName) */
  const businessName =
    (typeof customer.company_name === "string" && customer.company_name.trim()) ||
    (typeof meta.business_name === "string" && (meta.business_name as string).trim()) ||
    customer.email

  try {
    const result = await updateQboCustomer(qbo, conn, {
      qboCustomerId,
      businessName,
      email: customer.email,
      phone: customer.phone ?? null,
      firstName: customer.first_name ?? null,
      lastName: customer.last_name ?? null,
      addressLine1: billing?.address_1 ?? null,
      addressLine2: billing?.address_2 ?? null,
      city: billing?.city ?? null,
      state: billing?.province ?? null,
      zip: billing?.postal_code ?? null,
      country: billing?.country_code ?? "US",
      businessTypeLabel,
      ein: typeof meta.ein === "string" ? meta.ein : null,
      licenseNumber:
        (typeof meta.license_number === "string" && (meta.license_number as string)) ||
        (typeof meta.license === "string" && (meta.license as string)) ||
        null,
    })

    /* Clear pending flag + stamp last-synced. Use null (not delete) so
     * Medusa v2's metadata-merge stores the null and downstream reads
     * see it — same pattern as pricing-mode + payment-terms routes. */
    const nextMeta = { ...meta }
    nextMeta.qbo_sync_pending = false
    nextMeta.qbo_sync_pending_at = null
    nextMeta.qbo_last_synced_at = new Date().toISOString()
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })

    logger.info(`[push-qbo-updates] ${customer.email} → QBO Customer ${result.id} (${result.displayName})`)
    return res.json({ ok: true, qboCustomerId: result.id, displayName: result.displayName })
  } catch (e: any) {
    logger.error(`[push-qbo-updates] ${customer.email}: ${e?.message}`)
    return res.status(502).json({ ok: false, message: e?.message ?? "QBO update failed" })
  }
}

import { Modules } from "@medusajs/framework/utils"
import { findOrCreateCustomer, findQboTermIdByName, uploadCustomerAttachment } from "./qbo-api"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"

/**
 * Push a Medusa customer to QBO — find-or-create the Customer record,
 * upload EIN + resale-cert Attachables (sequential, to avoid QBO's
 * Stale Object Error), and stamp the resulting ids on customer.metadata.
 *
 * Shared between two surfaces:
 *   - approve-and-welcome route (initial push when operator approves)
 *   - retry-qbo-push route (operator-initiated retry without re-sending
 *     the welcome email when the initial push failed)
 *
 * Idempotent — skips create if qbo_customer_id is already stamped,
 * skips each attachment if its id is already stamped or its source URL
 * is missing.
 *
 * Persists the outcome on customer.metadata so the admin widget can
 * render the sync state across page reloads:
 *   - success: sets qbo_customer_id, clears qbo_push_error +
 *     qbo_push_error_at, stamps qbo_pushed_at
 *   - error:   sets qbo_push_error + qbo_push_error_at, leaves any
 *     previously-set qbo_customer_id intact (partial-progress retries
 *     still work — attachment-only retries don't need to re-create the
 *     Customer)
 */
export type CustomerPushOutcome =
  | { state: "skipped"; reason: string }
  | { state: "synced"; qboCustomerId: string; created: boolean }
  | { state: "error"; message: string }

type Logger = {
  info: (m: string) => void
  warn: (m: string) => void
  error?: (m: string) => void
}

type CustomerInput = {
  id: string
  email: string
  phone?: string | null
  first_name?: string | null
  last_name?: string | null
  metadata?: Record<string, any> | null
}

function fileExt(url: string): string {
  const m = url.split("?")[0].match(/\.([a-z0-9]+)$/i)
  return m ? `.${m[1].toLowerCase()}` : ""
}

export async function pushCustomerToQbo(
  scope: any,
  customer: CustomerInput,
  logger: Logger,
): Promise<CustomerPushOutcome> {
  const customerService: any = scope.resolve(Modules.CUSTOMER)
  let qbo: any
  try {
    qbo = scope.resolve(QBO_CONNECTION_MODULE)
  } catch {
    return { state: "skipped", reason: "QBO module not registered" }
  }

  const connRows = await qbo.listQboConnections({}, { take: 1 }).catch(() => [])
  const conn = connRows[0]
  if (!conn) {
    return { state: "skipped", reason: "QBO not connected — visit /app/quickbooks to authorize" }
  }

  const meta = (customer.metadata ?? {}) as Record<string, any>

  const existingQboId      = String(meta.qbo_customer_id ?? "")        || null
  const existingEinAtt     = String(meta.qbo_ein_attachment_id ?? "")  || null
  const existingLicenseAtt = String(meta.qbo_license_attachment_id ?? "") || null
  const einDocUrl          = String(meta.ein_doc_url ?? "")            || null
  const licenseDocUrl      = String(meta.license_doc_url ?? "")        || null

  /* Idempotent: skip the whole push if customer is already synced AND
   * both attachments are uploaded (or both source URLs are missing). */
  const einAttachmentDone     = !!existingEinAtt     || !einDocUrl
  const licenseAttachmentDone = !!existingLicenseAtt || !licenseDocUrl
  if (existingQboId && einAttachmentDone && licenseAttachmentDone) {
    /* Clear any stale error flag — we're fully synced. */
    if (meta.qbo_push_error) {
      try {
        const cleared = { ...meta }
        delete cleared.qbo_push_error
        delete cleared.qbo_push_error_at
        cleared.qbo_pushed_at = new Date().toISOString()
        await customerService.updateCustomers(customer.id, { metadata: cleared })
      } catch {
        /* Non-fatal — widget will show the stale error briefly. */
      }
    }
    return { state: "synced", qboCustomerId: existingQboId, created: false }
  }

  const businessName = String(meta.business_name ?? "").trim() || customer.email
  const firstName = String(customer.first_name ?? "").trim() || null
  const lastName  = String(customer.last_name ?? "").trim() || null
  const contactName = String(meta.contact_name ?? "").trim() || null
  const businessTypeLabel = String(meta.business_type_label ?? "").trim() || null

  /* Map payment_terms → QBO SalesTerm Id. */
  let salesTermId: string | null = null
  if (meta.payment_terms === "net15") {
    try {
      salesTermId = await findQboTermIdByName(qbo, conn, "Net 15")
    } catch (e: any) {
      logger.warn(`[push-customer-to-qbo] could not look up Net 15 term: ${e?.message}`)
    }
  }

  try {
    /* (1) Customer create — skip if already synced. */
    let qboCustomerId = existingQboId
    let created = false
    if (!qboCustomerId) {
      const result = await findOrCreateCustomer(qbo, conn, {
        businessName,
        email: customer.email,
        phone: customer.phone ?? null,
        addressLine1: meta.address_line1 ?? null,
        addressLine2: meta.address_line2 ?? null,
        city: meta.city ?? null,
        state: meta.state ?? null,
        zip: meta.zip ?? null,
        country: meta.country ?? "US",
        firstName,
        lastName,
        contactName,
        businessTypeLabel,
        salesTermId,
        notes: `Wholesale account · pushed ${new Date().toISOString().slice(0, 10)}`,
      })
      qboCustomerId = result.id
      created = result.created
    }

    /* (2) Attachment push — sequential to avoid Stale Object Error. */
    const businessSlug = (meta.business_name ?? customer.email).toString().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "customer"
    let einAttachmentId = existingEinAtt
    let licenseAttachmentId = existingLicenseAtt

    if (!einAttachmentId && einDocUrl) {
      try {
        const r = await uploadCustomerAttachment(qbo, conn, {
          customerId: qboCustomerId,
          sourceUrl: einDocUrl,
          fileName: `ein-${businessSlug}${fileExt(einDocUrl)}`,
          note: "EIN document — uploaded during wholesale application",
        })
        einAttachmentId = r.id
      } catch (e: any) {
        logger.warn(`[push-customer-to-qbo] EIN attachment push failed: ${e?.message}`)
      }
    }
    if (!licenseAttachmentId && licenseDocUrl) {
      try {
        const r = await uploadCustomerAttachment(qbo, conn, {
          customerId: qboCustomerId,
          sourceUrl: licenseDocUrl,
          fileName: `resale-cert-${businessSlug}${fileExt(licenseDocUrl)}`,
          note: "Resale certificate — uploaded during wholesale application",
        })
        licenseAttachmentId = r.id
      } catch (e: any) {
        logger.warn(`[push-customer-to-qbo] resale-cert attachment push failed: ${e?.message}`)
      }
    }

    /* (3) Stamp success state — clears any prior error. */
    const allAttachmentsDone =
      (!!einAttachmentId || !einDocUrl) &&
      (!!licenseAttachmentId || !licenseDocUrl)
    const nextMeta: Record<string, any> = {
      ...meta,
      qbo_customer_id: qboCustomerId,
      ...(einAttachmentId     ? { qbo_ein_attachment_id: einAttachmentId }         : {}),
      ...(licenseAttachmentId ? { qbo_license_attachment_id: licenseAttachmentId } : {}),
      ...(allAttachmentsDone  ? { qbo_attachments_pushed_at: new Date().toISOString() } : {}),
      qbo_pushed_at: new Date().toISOString(),
    }
    /* Clear any prior error — the push succeeded. Use delete so the
     * widget's `!!metadata.qbo_push_error` check evaluates false. */
    delete nextMeta.qbo_push_error
    delete nextMeta.qbo_push_error_at
    await customerService.updateCustomers(customer.id, { metadata: nextMeta })

    return { state: "synced", qboCustomerId, created }
  } catch (e: any) {
    /* Stamp the error so the widget can render it persistently. Truncate
     * to keep metadata jsonb small. */
    const message = (e?.message ?? "QBO push failed").toString().slice(0, 500)
    try {
      await customerService.updateCustomers(customer.id, {
        metadata: {
          ...meta,
          qbo_push_error: message,
          qbo_push_error_at: new Date().toISOString(),
        },
      })
    } catch (e2: any) {
      logger.warn(`[push-customer-to-qbo] couldn't stamp error: ${e2?.message}`)
    }
    logger.warn(`[push-customer-to-qbo] failed for ${customer.email}: ${message}`)
    return { state: "error", message }
  }
}

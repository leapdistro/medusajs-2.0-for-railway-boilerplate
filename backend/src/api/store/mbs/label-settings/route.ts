import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * GET /store/mbs/label-settings
 *
 * The printable label formats (weights + physical sizes) and the Code 128
 * barcode grid (branch → tier → format id), for a buyer who is allowed to
 * print labels.
 *
 * Three gates, all server-side:
 *   1. signed in            → 401
 *   2. in the "approved" group → 403
 *   3. metadata.labels_enabled === true → 403
 *
 * Gate 3 is the per-customer switch operators flip on the customer detail
 * page. It's checked HERE as well as on the storefront route so the
 * numbers never leave the backend for a buyer who shouldn't print.
 *
 * Archived formats are filtered out — they exist so a retired weight
 * keeps its barcodes, not so buyers keep printing it.
 */
const FORMATS_KEY = "label_formats"
const BARCODES_KEY = "label_barcodes"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id
  if (!customerId) {
    return res.status(401).json({ ok: false, message: "Sign in required" })
  }

  const customerService: any = req.scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService
    .listCustomers({ id: [customerId] }, { take: 1, relations: ["groups"] })
    .catch(() => [])
  if (!customer) {
    return res.status(404).json({ ok: false, message: "Customer not found" })
  }

  const isApproved = ((customer.groups ?? []) as Array<{ name?: string | null }>)
    .some((g) => g?.name === "approved")
  if (!isApproved) {
    return res.status(403).json({ ok: false, message: "Approval required" })
  }

  const labelsEnabled = (customer.metadata as Record<string, any> | undefined)?.labels_enabled === true
  if (!labelsEnabled) {
    return res.status(403).json({ ok: false, message: "Label printing is not enabled for this account" })
  }

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const [formatsRaw, barcodesRaw] = await Promise.all([
    settings.getSetting(FORMATS_KEY).catch(() => null),
    settings.getSetting(BARCODES_KEY).catch(() => null),
  ])

  const formats = (Array.isArray(formatsRaw) ? formatsRaw : [])
    .filter((f: any) => f?.id && f?.archived !== true)
    .map((f: any, i: number) => ({
      id: String(f.id),
      label: String(f.label ?? f.id),
      weight_text: String(f.weight_text ?? f.id).toUpperCase(),
      width_in: Number(f.width_in) || 0,
      height_in: Number(f.height_in) || 0,
      barcode: f.barcode !== false,
      order: Number.isFinite(Number(f.order)) ? Number(f.order) : i + 1,
    }))
    .filter((f: any) => f.width_in > 0 && f.height_in > 0)
    .sort((a: any, b: any) => a.order - b.order)

  return res.json({
    ok: true,
    formats,
    barcodes: barcodesRaw ?? {},
  })
}

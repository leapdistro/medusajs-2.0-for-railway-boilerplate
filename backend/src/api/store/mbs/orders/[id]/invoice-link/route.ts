import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { checkPrintToken } from "../../../../../../lib/print-link"

/**
 * GET /store/mbs/orders/:id/invoice-link
 * Header: x-mbs-invoice-token
 *
 * Checks an admin invoice print link (made by /admin/orders/:id/invoice)
 * for the storefront, which can't check the signature itself: the secret
 * stays here. 200 { ok: true } when the token is for this order and
 * hasn't expired, else 403.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const token = String(req.headers["x-mbs-invoice-token"] ?? "")
  if (!checkPrintToken("invoice-link", [req.params.id], token)) {
    return res.status(403).json({ ok: false, message: "This invoice link has expired. Open it again from the order in admin." })
  }
  return res.json({ ok: true })
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * GET /store/mbs/standalone-coas
 *
 * Lab reports that aren't attached to any product — strains we've had
 * tested but don't carry (yet). Operators manage them on the "COA
 * Library" tab of MBS Settings; the storefront lists them on /coas next
 * to the product COAs and streams the file via /coa/lab/<id>.
 *
 * PUBLIC on purpose, same as /coas itself: packaging QR codes point at
 * the library and anonymous scanners must be able to read it.
 *
 * Archived entries and entries with no file are dropped here so the
 * storefront never renders a dead Download button.
 */
const KEY = "standalone_coas"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const raw = await settings.getSetting(KEY).catch(() => null)

  const coas = (Array.isArray(raw) ? raw : [])
    .filter((c: any) => c?.id && c?.file_url && c?.archived !== true)
    .map((c: any) => ({
      id: String(c.id),
      strain: String(c.strain ?? c.id),
      category: String(c.category ?? "flower"),
      cannabinoid: c.cannabinoid ? String(c.cannabinoid) : null,
      primary_percent: c.primary_percent ? String(c.primary_percent) : null,
      total_cannabinoids: c.total_cannabinoids ? String(c.total_cannabinoids) : null,
      lab: c.lab ? String(c.lab) : null,
      reported: c.reported ? String(c.reported) : null,
      file_url: String(c.file_url),
    }))

  res.json({ coas })
}

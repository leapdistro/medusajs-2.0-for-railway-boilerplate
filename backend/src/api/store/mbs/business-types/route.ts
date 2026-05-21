import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * GET /store/mbs/business-types
 *
 * Public read of the `business_types` setting so the unauthenticated
 * wholesale apply form can populate its dropdown. Filters archived
 * entries server-side and exposes only the {id, label} pair the form
 * cares about. Admin settings widget is the editor.
 */

type Row = { id: string; label: string; archived?: boolean }

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const rows = ((await settings.getSetting("business_types", [])) ?? []) as Row[]
  const businessTypes = rows
    .filter((r) => !r.archived && r.id && r.label)
    .map((r) => ({ id: r.id, label: r.label }))
  res.json({ business_types: businessTypes })
}

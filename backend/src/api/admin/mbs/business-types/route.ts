import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * GET /admin/mbs/business-types
 *
 * Admin-auth-gated read of the `business_types` setting. Same payload
 * shape as the public `/store/mbs/business-types` route (filters
 * archived rows server-side, returns only `{id, label}`) — exists
 * separately because Medusa's /store/* routes require a publishable
 * API key header that admin widgets don't naturally carry. Admin
 * routes use admin auth which the widget already sends via
 * `credentials: "include"`.
 *
 * Used by: customer-application-docs.tsx (business type Select),
 * future admin widgets that need to pick a type.
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

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"

/**
 * Admin API for system settings.
 *
 *   GET  /admin/mbs/settings              → list every setting (id, key, value, description)
 *   POST /admin/mbs/settings              → write one — body { key, value, description? }
 *
 * The single-POST + key-in-body shape (vs a per-key route) keeps the
 * admin client trivial: one endpoint, dispatch via key. Idempotent — the
 * service layer upserts.
 *
 * Auth: lives under /admin/* so Medusa's admin auth middleware applies
 * automatically. No extra protection needed.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  const all = await settings.listSystemSettings({})
  res.json({ settings: all })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { key?: string; value?: unknown; description?: string }
  if (!body.key) {
    res.status(400).json({ ok: false, message: "key is required" })
    return
  }
  if (body.value === undefined) {
    res.status(400).json({ ok: false, message: "value is required" })
    return
  }
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  await settings.setSetting(body.key, body.value, body.description)
  const [row] = await settings.listSystemSettings({ key: body.key })
  res.json({ ok: true, setting: row })
}

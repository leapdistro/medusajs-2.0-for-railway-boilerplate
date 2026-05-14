import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getProfile, type ProfileKey } from "../../../../../lib/receiving-profiles"

/**
 * GET /admin/receiving/profile/:key
 *
 * Returns the static ReceivingProfile config so the admin pre-roll
 * receiving page (and any future profile-driven page) can render
 * subcategory dropdowns / variant hints / field gating from a single
 * source of truth — no hardcoded duplicates in the UI.
 *
 * Adding a new subcategory under Pre-Rolls is a one-line edit in
 * receiving-profiles.ts; the receiving page picks it up on next load.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const key = req.params.key as ProfileKey
  try {
    const profile = getProfile(key)
    return res.json({ profile })
  } catch (e: any) {
    return res.status(404).json({ error: e?.message ?? `Unknown profile: ${key}` })
  }
}

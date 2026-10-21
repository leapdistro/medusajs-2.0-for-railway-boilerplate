import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findProfile, resolveProfileCategories } from "../../../../../lib/profile-store"

/**
 * GET /admin/receiving/profile/:key
 *
 * Returns the receiving profile (from MBS Settings → Categories, or the
 * built-in one until that's saved) MERGED with the live Medusa
 * categories under its root, so a sub-category added in Medusa admin
 * shows up in the receiving page and the price grids with no code
 * change. Merge rules live in resolveProfileCategories
 * (lib/profile-store.ts); receiving save uses the same list.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const key = req.params.key
  const profile = await findProfile(req.scope, key)
  if (!profile) {
    return res.status(404).json({ error: `Unknown receiving profile: ${key}` })
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const resolved = await resolveProfileCategories(query, profile)
  if (!resolved.enumRoot) {
    /* Root category missing in Medusa — return the profile as configured.
     * Receiving save fails with a clear error anyway. */
    return res.json({ profile, source: "profile-only" })
  }
  return res.json({ profile: resolved.profile, source: "merged" })
}

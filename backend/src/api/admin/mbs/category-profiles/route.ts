import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"
import {
  CATEGORY_PROFILES_KEY,
  loadProfiles,
  normalizeProfileList,
} from "../../../../lib/profile-store"

/**
 * GET  /admin/mbs/category-profiles
 *   → { profiles, source, categories }
 *   `source` is "built-in" until the Categories tab is first saved.
 *   `categories` is the Medusa tree (id, name, handle, parent) for the
 *   parent / sub-category-root pickers.
 *
 * POST /admin/mbs/category-profiles  body { profiles }
 *   Validates every profile (lib/profile-store normalizeProfile) and
 *   writes the whole list to the `category_profiles` setting. Rejects
 *   the save with the reasons when anything is invalid, so receiving
 *   never reads a half-valid profile. Unknown Medusa categories are
 *   returned as warnings, not errors: the operator may create the
 *   category after setting up its profile.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { profiles, source } = await loadProfiles(req.scope)
  const categories = await listCategories(req)
  res.json({ profiles, source, categories })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as { profiles?: unknown }
  const { profiles, errors } = normalizeProfileList(body.profiles)
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, message: errors.join("\n"), errors })
  }
  if (profiles.length === 0) {
    return res.status(400).json({ ok: false, message: "At least one category is required." })
  }

  const categories = await listCategories(req)
  const warnings: string[] = []
  for (const p of profiles) {
    const parent = categories.find((c) => c.name === p.parentCategoryName && !c.parent_category_id)
    if (!parent) warnings.push(`${p.displayName}: no top-level Medusa category named "${p.parentCategoryName}" yet.`)
    if (p.subcategoryParentHandle && !categories.some((c) => c.handle === p.subcategoryParentHandle)) {
      warnings.push(`${p.displayName}: no Medusa category with handle "${p.subcategoryParentHandle}" yet.`)
    }
  }

  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  await settings.setSetting(
    CATEGORY_PROFILES_KEY,
    profiles,
    "Receiving setup per category: units, sizes, fields, price table. Edited in MBS Settings → Categories.",
  )
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  logger.info(`[category-profiles] saved ${profiles.length} profiles (${profiles.map((p) => p.key).join(", ")})`)
  res.json({ ok: true, profiles, warnings })
}

async function listCategories(req: MedusaRequest) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id"],
  })
  return (data ?? []) as Array<{ id: string; name: string; handle: string; parent_category_id: string | null }>
}

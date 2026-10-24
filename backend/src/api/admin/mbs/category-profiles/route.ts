import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"
import {
  CATEGORY_PROFILES_KEY,
  findProfileRoot,
  loadProfiles,
  normalizeProfileList,
  resolveProfileCategories,
  type Category,
} from "../../../../lib/profile-store"

/**
 * GET  /admin/mbs/category-profiles
 *   → { profiles, source, categories, unlinked }
 *   `source` is "built-in" until the Categories tab is first saved.
 *   Each profile comes back linked to its Medusa categories by id, with
 *   its live sub-categories listed and live names filled in, so the next
 *   save stores ids and a rename in Medusa can't break it.
 *   `categories` is the Medusa tree; `unlinked` are top-level categories
 *   no profile receives into ("Not set up" in the tab).
 *
 * POST /admin/mbs/category-profiles  body { profiles }
 *   Validates every profile (lib/profile-store normalizeProfile) and
 *   writes the whole list to the `category_profiles` setting. Rejects
 *   the save with the reasons when anything is invalid, so receiving
 *   never reads a half-valid profile. A profile whose Medusa category
 *   is missing comes back as a warning, not an error.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { profiles, source } = await loadProfiles(req.scope)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const linked = await Promise.all(profiles.map((p) => resolveProfileCategories(query, p)))
  const categories = await listCategories(req)
  const covered = new Set(linked.map((r) => r.parent?.id).filter(Boolean))
  const unlinked = categories.filter((c) => !c.parent_category_id && !covered.has(c.id))
  res.json({ profiles: linked.map((r) => r.linked), source, categories, unlinked })
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
    if (!findProfileRoot(categories, p).enumRoot) {
      warnings.push(`${p.displayName}: its Medusa category doesn't exist (deleted?). Receiving it will fail until you pick one.`)
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
    fields: ["id", "name", "handle", "parent_category_id", "is_active"],
  })
  return (data ?? []) as Category[]
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * The brands on the site, for the storefront header menu: each Medusa
 * collection (lib/brand.ts) with at least one published product in an
 * active category, as { handle, name }, sorted by name. Same filters as
 * /store/mbs/products, so a brand shows in the menu exactly when its page
 * has products. Small and the same for every visitor: the storefront
 * caches it, where reading brands off the full catalog sent ~1.8 MB on
 * every page view.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product",
    fields: ["collection.handle", "collection.title"],
    filters: { status: "published", categories: { is_active: true } },
  })
  const byHandle = new Map<string, string>()
  for (const p of data as any[]) {
    const c = p.collection
    if (c?.handle && c.title) byHandle.set(c.handle, c.title)
  }
  const brands = [...byHandle]
    .map(([handle, name]) => ({ handle, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  res.json({ brands })
}

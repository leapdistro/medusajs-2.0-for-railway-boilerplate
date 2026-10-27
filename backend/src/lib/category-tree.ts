/**
 * The whole Medusa category table, read once, with each category's
 * top-level ancestor. Read without the store's is_active filter so a
 * deactivated middle level (Flower → CBG, Flower → THC-A) still links a
 * tier to its parent.
 */

export type TreeCategory = {
  id: string; name: string; handle: string; parent_category_id?: string | null
  is_active?: boolean; metadata?: Record<string, unknown> | null
}

/** One level of a product's category path, as the storefront reads it. */
export type PathCategory = { id: string; handle: string; name: string; is_active: boolean; metadata: Record<string, unknown> }

export type CategoryTree = {
  byId: Map<string, TreeCategory>
  /** The top-level category above `id` (itself when it has no parent). */
  rootOf: (id: string) => TreeCategory | null
  /** Top-level category down to `id`, inactive levels included. */
  pathOf: (id: string) => TreeCategory[]
}

/* Display-only keys (Storefront display: tile, intro, home section). A
 * product's path carries every other key, so product behaviour set on a
 * category (cannabinoid, productMeta, labels, …) reaches the storefront
 * without a code change here. */
const DISPLAY_ONLY = /^(intro|tile[A-Z_]|tile_|home[A-Z]|sortOrder|sort_order|comingSoon|coming_soon)/

/** A product's deepest category assignment as a path from its top-level
 *  category, with each level's behaviour metadata. */
export function productPath(tree: CategoryTree, categoryIds: string[]): PathCategory[] {
  let best: TreeCategory[] = []
  for (const id of categoryIds) {
    const path = tree.pathOf(id)
    if (path.length > best.length) best = path
  }
  return best.map((c) => ({
    id: c.id,
    handle: c.handle,
    name: c.name,
    is_active: c.is_active !== false,
    metadata: Object.fromEntries(Object.entries(c.metadata ?? {}).filter(([k]) => !DISPLAY_ONLY.test(k))),
  }))
}

export async function loadCategoryTree(query: any): Promise<CategoryTree> {
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id", "is_active", "metadata"],
  })
  const byId = new Map<string, TreeCategory>(((data ?? []) as TreeCategory[]).map((c) => [c.id, c]))
  const rootOf = (id: string) => {
    let node = byId.get(id) ?? null
    for (let hops = 0; node?.parent_category_id && byId.has(node.parent_category_id) && hops < 20; hops++) {
      node = byId.get(node.parent_category_id)!
    }
    return node
  }
  const pathOf = (id: string) => {
    const out: TreeCategory[] = []
    for (let node = byId.get(id) ?? null; node && out.length < 20; node = node.parent_category_id ? byId.get(node.parent_category_id) ?? null : null) {
      out.unshift(node)
    }
    return out
  }
  return { byId, rootOf, pathOf }
}

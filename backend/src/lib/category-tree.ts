/**
 * The whole Medusa category table, read once, with each category's
 * top-level ancestor. Read without the store's is_active filter so a
 * deactivated middle level (Flower → CBG, Flower → THC-A) still links a
 * tier to its parent.
 */

export type TreeCategory = { id: string; name: string; handle: string; parent_category_id?: string | null }

export type CategoryTree = {
  byId: Map<string, TreeCategory>
  /** The top-level category above `id` (itself when it has no parent). */
  rootOf: (id: string) => TreeCategory | null
}

export async function loadCategoryTree(query: any): Promise<CategoryTree> {
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id"],
  })
  const byId = new Map<string, TreeCategory>(((data ?? []) as TreeCategory[]).map((c) => [c.id, c]))
  const rootOf = (id: string) => {
    let node = byId.get(id) ?? null
    for (let hops = 0; node?.parent_category_id && byId.has(node.parent_category_id) && hops < 20; hops++) {
      node = byId.get(node.parent_category_id)!
    }
    return node
  }
  return { byId, rootOf }
}

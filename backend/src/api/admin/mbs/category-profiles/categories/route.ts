import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow,
  updateProductCategoriesWorkflow,
} from "@medusajs/medusa/core-flows"
import { slugifyKey } from "../../../../../lib/profile-store"

/**
 * POST /admin/mbs/category-profiles/categories
 *
 * Lets MBS Settings → Categories manage the Medusa categories itself, so
 * the operator never has to set a category up twice.
 *
 *   { action: "create", name, parentId?, subcategories?: string[] }
 *     → a new category (top-level, or under parentId) plus its children.
 *   { action: "add-sub", parentId, name } → one new child.
 *   { action: "rename", id, name } → new name; the handle (and so every
 *     storefront URL) stays.
 *
 * New categories are active and public. Category profiles link to them
 * by id (lib/profile-store.ts), so a later rename changes nothing else.
 */

type Cat = { id: string; name: string; handle: string; parent_category_id: string | null }

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body ?? {}) as {
    action?: string
    id?: string
    parentId?: string
    name?: string
    subcategories?: unknown
  }
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return res.status(400).json({ ok: false, message: "A name is required." })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id"],
  })
  const cats = (data ?? []) as Cat[]
  const byId = new Map(cats.map((c) => [c.id, c]))
  const handles = new Set(cats.map((c) => c.handle))
  const siblingNamed = (parentId: string | null, n: string, except?: string) =>
    cats.find((c) => (c.parent_category_id ?? null) === parentId && c.name.toLowerCase() === n.toLowerCase() && c.id !== except)

  /* Children get the parent's handle as a prefix (pre-rolls-cbd), since
   * handles are unique across the whole store and names like "CBD"
   * repeat under different parents. */
  const handleFor = (n: string, parentHandle: string | null) => {
    const base = slugifyKey(parentHandle ? `${parentHandle}-${n}` : n)
    let h = base
    for (let i = 2; handles.has(h); i++) h = `${base}-${i}`
    handles.add(h)
    return h
  }

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  if (body.action === "rename") {
    const cat = body.id ? byId.get(body.id) : undefined
    if (!cat) return res.status(404).json({ ok: false, message: "That category no longer exists in Medusa." })
    if (siblingNamed(cat.parent_category_id ?? null, name, cat.id)) {
      return res.status(400).json({ ok: false, message: `There's already a "${name}" next to it.` })
    }
    await updateProductCategoriesWorkflow(req.scope).run({
      input: { selector: { id: cat.id }, update: { name } },
    })
    logger.info(`[category-profiles] renamed category ${cat.id} "${cat.name}" → "${name}"`)
    return res.json({ ok: true, category: { ...cat, name } })
  }

  if (body.action === "add-sub") {
    const parent = body.parentId ? byId.get(body.parentId) : undefined
    if (!parent) return res.status(404).json({ ok: false, message: "The parent category no longer exists in Medusa." })
    if (siblingNamed(parent.id, name)) {
      return res.status(400).json({ ok: false, message: `${parent.name} already has a "${name}".` })
    }
    const { result } = await createProductCategoriesWorkflow(req.scope).run({
      input: {
        product_categories: [{
          name,
          handle: handleFor(name, parent.handle),
          parent_category_id: parent.id,
          is_active: true,
          is_internal: false,
        }],
      },
    })
    logger.info(`[category-profiles] added "${name}" under ${parent.name} (${result[0]?.id})`)
    return res.json({ ok: true, category: result[0] })
  }

  if (body.action === "create") {
    const parent = body.parentId ? byId.get(body.parentId) : undefined
    if (body.parentId && !parent) {
      return res.status(404).json({ ok: false, message: "The category to put it under no longer exists in Medusa." })
    }
    if (siblingNamed(parent?.id ?? null, name)) {
      return res.status(400).json({ ok: false, message: `"${name}" already exists${parent ? ` under ${parent.name}` : ""}. Set it up from the list instead.` })
    }
    const subNames = Array.isArray(body.subcategories)
      ? Array.from(new Set(body.subcategories.map((s) => String(s ?? "").trim()).filter(Boolean)))
      : []

    const handle = handleFor(name, parent?.handle ?? null)
    const { result: created } = await createProductCategoriesWorkflow(req.scope).run({
      input: {
        product_categories: [{
          name,
          handle,
          parent_category_id: parent?.id ?? null,
          is_active: true,
          is_internal: false,
        }],
      },
    })
    const category = created[0]
    let subcategories: any[] = []
    if (subNames.length > 0) {
      const { result } = await createProductCategoriesWorkflow(req.scope).run({
        input: {
          product_categories: subNames.map((n) => ({
            name: n,
            handle: handleFor(n, handle),
            parent_category_id: category.id,
            is_active: true,
            is_internal: false,
          })),
        },
      })
      subcategories = result
    }
    logger.info(`[category-profiles] created "${name}" (${category.id}) with ${subcategories.length} sub-categories`)
    return res.json({ ok: true, category, subcategories })
  }

  return res.status(400).json({ ok: false, message: `Unknown action "${body.action}".` })
}

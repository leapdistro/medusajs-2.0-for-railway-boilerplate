import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { loadPlannerSheet, plannerAccess, priceKey, type SavedPlan } from "../../../../../../../../lib/packaging-planner"

/**
 * GET  /store/mbs/customers/me/orders/:id/packaging-plan
 * POST /store/mbs/customers/me/orders/:id/packaging-plan
 *
 * Packaging Planner for an Owner Stores buyer's own order (see
 * lib/packaging-planner.ts). GET returns the sheet: bulk flower lines by
 * tier with cost + shipping share, retail sizes with packaging cost, the
 * saved plan and the buyer's remembered selling prices.
 *
 * POST body: { usable_grams_per_unit, rows: { <line key>: { <size id>: { qty, price } } } }
 * Saves the plan on order.metadata.packaging_plan and remembers each
 * entered selling price per tier + size on customer.metadata.packaging_prices
 * (the next sheet starts from those). Going over the available grams is
 * allowed — the sheet warns; it's the buyer's call.
 *
 * Both are refused for anyone but the order's customer on Owner Stores
 * pricing.
 */
const actorOf = (req: MedusaRequest) =>
  (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const access = await plannerAccess(req.scope, req.params.id, actorOf(req))
  if (access.status !== 200) return res.status(access.status).json({ ok: false, message: access.message })
  const sheet = await loadPlannerSheet(req.scope, req.params.id, access.customer)
  res.setHeader("Cache-Control", "no-store")
  return res.json({ ok: true, sheet })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderId = req.params.id
  const access = await plannerAccess(req.scope, orderId, actorOf(req))
  if (access.status !== 200) return res.status(access.status).json({ ok: false, message: access.message })

  const body = (req.body ?? {}) as { usable_grams_per_unit?: unknown; rows?: unknown }
  const usable = Number(body.usable_grams_per_unit)
  if (!Number.isFinite(usable) || usable <= 0 || usable > 1000) {
    return res.status(400).json({ ok: false, message: "Usable grams per QP must be a positive number" })
  }

  /* Keep only lines and sizes that are on this order's sheet. */
  const sheet = await loadPlannerSheet(req.scope, orderId, access.customer)
  const sizeIds = new Set(sheet.sizes.map((s) => s.id))
  const groupOfLine = new Map<string, string>()
  for (const g of sheet.groups) for (const l of g.lines) groupOfLine.set(l.key, g.key)

  const rows: SavedPlan["rows"] = {}
  const remember: Record<string, number> = {}
  for (const [lineKey, sizes] of Object.entries((body.rows ?? {}) as Record<string, any>)) {
    const groupKey = groupOfLine.get(lineKey)
    if (!groupKey || !sizes || typeof sizes !== "object") continue
    for (const [sizeId, cell] of Object.entries(sizes as Record<string, any>)) {
      if (!sizeIds.has(sizeId)) continue
      const qty = Math.floor(Number(cell?.qty))
      const priceRaw = cell?.price
      const price = priceRaw === null || priceRaw === "" || priceRaw === undefined ? null : Number(priceRaw)
      if (!Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({ ok: false, message: "Quantities must be whole numbers, 0 or more" })
      }
      if (price !== null && (!Number.isFinite(price) || price < 0)) {
        return res.status(400).json({ ok: false, message: "Selling prices must be 0 or more" })
      }
      if (qty === 0 && price === null) continue
      ;(rows[lineKey] ??= {})[sizeId] = { qty, price: price === null ? null : Math.round(price * 100) / 100 }
      if (price !== null && price > 0) remember[priceKey(groupKey, sizeId)] = Math.round(price * 100) / 100
    }
  }

  const plan: SavedPlan = { usable_grams_per_unit: usable, rows, saved_at: new Date().toISOString() }
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const orderService: any = req.scope.resolve(Modules.ORDER)
  const customerService: any = req.scope.resolve(Modules.CUSTOMER)

  /* Re-read metadata right before writing so keys other flows stamp
   * (QBO sync, price edits) aren't put back to an older snapshot. */
  const { data: fresh } = await query.graph({ entity: "order", fields: ["metadata"], filters: { id: orderId } })
  const metadata = ((fresh as any[])[0]?.metadata ?? {}) as Record<string, any>
  await orderService.updateOrders(orderId, { metadata: { ...metadata, packaging_plan: plan } })

  if (Object.keys(remember).length > 0) {
    const prev = (access.customer.metadata as Record<string, any> | null)?.packaging_prices
    await customerService.updateCustomers(access.customer.id, {
      metadata: { packaging_prices: { ...(prev && typeof prev === "object" ? prev : {}), ...remember } },
    })
  }

  return res.json({ ok: true, plan })
}

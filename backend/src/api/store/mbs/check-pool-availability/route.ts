import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * POST /store/mbs/check-pool-availability
 *
 * Validates whether adding `(variantId × quantity)` to `cartId` would
 * over-commit any shared inventory pool. Solves the bug where Medusa's
 * native cart.add lets a buyer accept 2 LB + 4 Half + 8 QP from a
 * pool of 8 QPs (24 QPs demanded; checkout fails confusingly).
 *
 * Mechanics:
 *   1. Resolve the candidate variant's inventory_items + required_qty
 *   2. Fetch the cart's current items + their inventory_items
 *   3. Sum demand per shared inventory_item_id (existing items + new add)
 *   4. Fetch each pool's available_quantity (across all locations)
 *   5. Reject if any pool's demand > available
 *
 * Body:
 *   { cartId?: string, variantId: string, quantity: number }
 *
 * Returns:
 *   200 { ok: true }
 *   200 { ok: false, error: "...", details?: { ... } }
 */

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { cartId?: string; variantId?: string; quantity?: number }
  const cartId = body.cartId
  const variantId = String(body.variantId ?? "")
  const quantity = Number(body.quantity)

  if (!variantId) { res.status(400).json({ ok: false, error: "variantId is required" }); return }
  if (!Number.isFinite(quantity) || quantity < 1) {
    res.status(400).json({ ok: false, error: "quantity must be a positive integer" }); return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const inventoryService: any = req.scope.resolve(Modules.INVENTORY)

  /* 1. Candidate variant — its inventory items + required quantities. */
  const { data: candVariants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "title",
      "manage_inventory",
      "inventory_items.inventory.id",
      "inventory_items.required_quantity",
    ],
    filters: { id: variantId },
  })
  const cand = candVariants?.[0] as any
  if (!cand) {
    res.status(404).json({ ok: false, error: "Variant not found" }); return
  }
  /* If the variant doesn't manage inventory, no pool check applies. */
  if (cand.manage_inventory === false) {
    res.json({ ok: true }); return
  }
  const candNeeds: Array<{ inventoryItemId: string; required: number }> = (cand.inventory_items ?? [])
    .map((ii: any) => ({
      inventoryItemId: ii.inventory?.id,
      required: Number(ii.required_quantity ?? 1),
    }))
    .filter((n: any) => n.inventoryItemId)
  if (candNeeds.length === 0) {
    /* Variant has no inventory items at all — Medusa will fail
     * gracefully or accept; let it pass our gate. */
    res.json({ ok: true }); return
  }

  /* 2. Existing cart items — pull their variants + inventory items
   *    so we can compute demand on the same pool. */
  const existingDemand = new Map<string, number>()
  if (cartId) {
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "items.id",
        "items.quantity",
        "items.variant_id",
      ],
      filters: { id: cartId },
    })
    const items = (carts?.[0] as any)?.items ?? []
    if (items.length > 0) {
      const variantIds = items.map((i: any) => i.variant_id).filter(Boolean)
      const { data: existingVariants } = await query.graph({
        entity: "product_variant",
        fields: [
          "id",
          "inventory_items.inventory.id",
          "inventory_items.required_quantity",
        ],
        filters: { id: variantIds },
      })
      const variantInvMap = new Map<string, Array<{ id: string; required: number }>>()
      for (const v of (existingVariants as any[]) ?? []) {
        variantInvMap.set(
          v.id,
          (v.inventory_items ?? []).map((ii: any) => ({
            id: ii.inventory?.id,
            required: Number(ii.required_quantity ?? 1),
          })).filter((n: any) => n.id),
        )
      }
      for (const it of items) {
        const inv = variantInvMap.get(it.variant_id) ?? []
        for (const n of inv) {
          existingDemand.set(n.id, (existingDemand.get(n.id) ?? 0) + it.quantity * n.required)
        }
      }
    }
  }

  /* 3. Add the candidate's demand. */
  const totalDemand = new Map<string, number>()
  for (const [id, q] of existingDemand) totalDemand.set(id, q)
  for (const n of candNeeds) {
    totalDemand.set(n.inventoryItemId, (totalDemand.get(n.inventoryItemId) ?? 0) + quantity * n.required)
  }

  /* 4. For each affected pool, fetch available stock (sum of all
   *    location levels, minus reserved). For our setup with one
   *    warehouse this simplifies to stocked_quantity. */
  const failures: Array<{ pool: string; available: number; demanded: number }> = []
  for (const [inventoryItemId, demanded] of totalDemand) {
    try {
      const levels = await inventoryService.listInventoryLevels({
        inventory_item_id: inventoryItemId,
      })
      const totalStock = (levels ?? []).reduce((s: number, lv: any) =>
        s + Number(lv.stocked_quantity ?? 0) - Number(lv.reserved_quantity ?? 0), 0)
      if (demanded > totalStock) {
        failures.push({ pool: inventoryItemId, available: totalStock, demanded })
      }
    } catch (e: any) {
      /* If we can't read inventory, fall through and let Medusa decide. */
    }
  }

  if (failures.length === 0) {
    res.json({ ok: true })
    return
  }

  /* Format a friendly error. With the typical pool case there's just
   * one pool — the one this variant + its siblings share. */
  const f = failures[0]
  const newDemand = candNeeds[0]?.required ? quantity * candNeeds[0].required : quantity
  const existing = existingDemand.get(f.pool) ?? 0
  const remaining = Math.max(0, f.available - existing)
  /* How many of THIS variant fits in what's left? */
  const requiredPerOne = candNeeds.find((n) => n.inventoryItemId === f.pool)?.required ?? 1
  const maxOfThisVariant = Math.floor(remaining / requiredPerOne)
  res.json({
    ok: false,
    error: `Only ${maxOfThisVariant} ${cand.title ?? "of this size"} can fit (${f.available} units in pool, ${existing} already in your cart).`,
    details: {
      poolAvailable: f.available,
      alreadyInCart: existing,
      youAreAdding: newDemand,
      maxAdditionalOfThisVariant: maxOfThisVariant,
    },
  })
}

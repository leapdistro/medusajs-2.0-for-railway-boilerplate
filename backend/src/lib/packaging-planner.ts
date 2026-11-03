import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"
import { loadCategoryTree, productPath, type PathCategory } from "./category-tree"
import { formatGrams } from "./label-weight"

/**
 * Packaging Planner — Owner Stores repack bulk flower (QP / ½ LB / LB)
 * into retail weights. This builds the sheet for one of their orders:
 * the flower they bought (cost incl. a share of shipping), grouped by
 * tier, plus the retail sizes and packaging costs to plan with.
 *
 * Sources, nothing hardcoded:
 *   - sizes: MBS Settings label formats with a gram weight (1g … 28g);
 *     QP has none, so it's not a size.
 *   - packaging cost per size + default usable grams per pool unit (QP):
 *     MBS Settings `packaging_planner`.
 *   - which lines: products whose category path resolves `labels: true`
 *     (weight-labelled flower) and whose variant is bulk: net grams per
 *     pool unit above the largest size. A 28g jar box isn't repackable.
 *   - pool units per variant: the inventory link's required_quantity
 *     (QP = 1, ½ LB = 2, LB = 4), the same multiplier receiving uses.
 *   - tier: the path level with `tier_key` (else the third level).
 *
 * The storefront does the arithmetic (cost per gram, margins) from this
 * raw sheet so the planner and its PDF compute the same way.
 */
export const PLANNER_SETTINGS_KEY = "packaging_planner"
const LABEL_FORMATS_KEY = "label_formats"
export const DEFAULT_USABLE_GRAMS = 110

export type PlannerSettings = {
  usable_grams_per_unit: number
  /** Packaging cost per label format id (jar/bag + label). */
  packaging_costs: Record<string, number>
}

export type PlannerSize = { id: string; label: string; grams: number; packaging_cost: number }
export type PlannerLine = {
  key: string
  product: string
  sizes_bought: string[]
  units: number
  goods_cost: number
  shipping_share: number
}
export type PlannerGroup = { key: string; tier: string; category: string; accent: string | null; sort_order: number; lines: PlannerLine[] }
export type SavedPlan = {
  usable_grams_per_unit: number
  rows: Record<string, Record<string, { qty: number; price: number | null }>>
  saved_at: string
}
export type PlannerSheet = {
  order: { id: string; display_id: number | null; created_at: string }
  default_usable_grams_per_unit: number
  sizes: PlannerSize[]
  shipping_total: number
  groups: PlannerGroup[]
  plan: SavedPlan | null
  remembered_prices: Record<string, number>
}

export function readPlannerSettings(raw: unknown): PlannerSettings {
  const v = (raw ?? {}) as Record<string, any>
  const usable = Number(v.usable_grams_per_unit)
  const costs: Record<string, number> = {}
  for (const [k, c] of Object.entries((v.packaging_costs ?? {}) as Record<string, unknown>)) {
    const n = Number(c)
    if (Number.isFinite(n) && n >= 0) costs[k] = n
  }
  return {
    usable_grams_per_unit: Number.isFinite(usable) && usable > 0 ? usable : DEFAULT_USABLE_GRAMS,
    packaging_costs: costs,
  }
}

/** Key for a remembered selling price: the tier group + size. */
export const priceKey = (groupKey: string, sizeId: string) => `${groupKey}|${sizeId}`

const num = (v: unknown): number => {
  if (v == null) return 0
  if (typeof v === "number") return v
  if (typeof v === "object" && v !== null && "numeric" in v) return Number((v as any).numeric)
  if (typeof v === "object" && v !== null && "value" in v) return Number((v as any).value)
  return Number(v) || 0
}
const round2 = (n: number) => Math.round(n * 100) / 100

function setting(path: PathCategory[], key: string): unknown {
  for (let i = path.length - 1; i >= 0; i--) {
    const v = path[i].metadata?.[key]
    if (v !== undefined && v !== null && v !== "") return v
  }
  return undefined
}

/** Who may plan: the order's own customer, on Owner Stores pricing. */
export async function plannerAccess(scope: any, orderId: string, customerId: string | undefined) {
  if (!customerId) return { status: 401, message: "Sign in required" } as const
  const customerService: any = scope.resolve(Modules.CUSTOMER)
  const [customer] = await customerService.listCustomers({ id: [customerId] }, { take: 1 }).catch(() => [])
  if (!customer) return { status: 404, message: "Customer not found" } as const
  if ((customer.metadata as Record<string, any> | null)?.pricing_mode !== "owner_stores") {
    return { status: 403, message: "The Packaging Planner is for Owner Stores accounts" } as const
  }
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "order", fields: ["id", "customer_id"], filters: { id: orderId } })
  const order = (data as any[])[0]
  if (!order || order.customer_id !== customerId) return { status: 404, message: "Order not found" } as const
  return { status: 200, customer } as const
}

export async function loadPlannerSheet(scope: any, orderId: string, customer: any): Promise<PlannerSheet> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const settingsService: any = scope.resolve(MBS_SETTINGS_MODULE)

  const [{ data: orders }, formatsRaw, plannerRaw, tree] = await Promise.all([
    query.graph({
      entity: "order",
      fields: [
        "id", "display_id", "created_at", "metadata",
        "items.id", "items.product_id", "items.variant_id", "items.product_title", "items.variant_title",
        "items.quantity", "items.detail.quantity", "items.unit_price", "items.detail.unit_price",
        "items.variant.metadata",
        "shipping_methods.amount",
      ],
      filters: { id: orderId },
    }),
    settingsService.getSetting(LABEL_FORMATS_KEY).catch(() => null),
    settingsService.getSetting(PLANNER_SETTINGS_KEY).catch(() => null),
    loadCategoryTree(query),
  ])
  const order = (orders as any[])[0]
  const settings = readPlannerSettings(plannerRaw)

  const sizes: PlannerSize[] = (Array.isArray(formatsRaw) ? formatsRaw : [])
    .filter((f: any) => f?.id && f?.archived !== true)
    .map((f: any, i: number) => ({ f, i, grams: formatGrams(f) }))
    .filter((x: any) => x.grams != null && x.grams > 0)
    .sort((a: any, b: any) => (Number(a.f.order) || a.i) - (Number(b.f.order) || b.i) || a.grams - b.grams)
    .map(({ f, grams }: any) => ({
      id: String(f.id),
      label: String(f.label ?? f.id),
      grams,
      packaging_cost: settings.packaging_costs[String(f.id)] ?? 0,
    }))
  const largestSize = Math.max(0, ...sizes.map((s) => s.grams))

  const items = ((order?.items ?? []) as any[])
    .map((i) => ({
      ...i,
      qty: num(i.detail?.quantity ?? i.quantity),
      price: num(i.detail?.unit_price ?? i.unit_price),
    }))
    .filter((i) => i.qty > 0)
  const goodsTotal = items.reduce((s, i) => s + i.qty * i.price, 0)
  const shippingTotal = ((order?.shipping_methods ?? []) as any[]).reduce((s, m) => s + num(m.amount), 0)

  /* Pool units per variant (QP = 1, ½ LB = 2, LB = 4). */
  const variantIds = [...new Set(items.map((i) => i.variant_id).filter(Boolean))]
  const poolUnits = new Map<string, number>()
  if (variantIds.length) {
    const r = await pg.raw(
      `select variant_id, required_quantity from product_variant_inventory_item
        where variant_id = any(?) and deleted_at is null`,
      [variantIds],
    )
    for (const row of r.rows) poolUnits.set(row.variant_id, Number(row.required_quantity) || 1)
  }

  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))]
  const pathByProduct = new Map<string, PathCategory[]>()
  if (productIds.length) {
    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "categories.id"],
      filters: { id: productIds },
      withDeleted: true,
    })
    for (const p of products as any[]) {
      pathByProduct.set(p.id, productPath(tree, (p.categories ?? []).map((c: any) => c.id)))
    }
  }

  const groups = new Map<string, PlannerGroup>()
  for (const i of items) {
    const path = pathByProduct.get(i.product_id) ?? []
    if (setting(path, "labels") !== true) continue
    const units = poolUnits.get(i.variant_id) ?? 1
    const netGrams = num(i.variant?.metadata?.net_grams)
    if (!(netGrams > 0) || netGrams / units <= largestSize) continue

    let t = path.findIndex((c) => typeof c.metadata?.tier_key === "string" && c.metadata.tier_key)
    if (t < 0 && path.length >= 3) t = path.length - 1
    const tierCat = t >= 0 ? path[t] : null
    const above = t >= 0 ? path.slice(0, t) : path
    const groupKey = above.map((c) => c.handle).concat(tierCat ? [String(tierCat.metadata?.tier_key ?? tierCat.handle)] : []).join("/") || "other"
    const group = groups.get(groupKey) ?? {
      key: groupKey,
      tier: tierCat?.name ?? "Other",
      category: above.map((c) => c.name).join(" › "),
      accent: typeof tierCat?.metadata?.accent === "string" ? (tierCat.metadata.accent as string) : null,
      /* productPath drops display keys like sortOrder; read the tree. */
      sort_order: Number(tierCat ? tree.byId.get(tierCat.id)?.metadata?.sortOrder : undefined) || 999,
      lines: [],
    }
    groups.set(groupKey, group)

    const lineCost = i.qty * i.price
    const key = String(i.product_id ?? i.id)
    let line = group.lines.find((l) => l.key === key)
    if (!line) {
      line = { key, product: i.product_title ?? "", sizes_bought: [], units: 0, goods_cost: 0, shipping_share: 0 }
      group.lines.push(line)
    }
    line.units += i.qty * units
    line.goods_cost = round2(line.goods_cost + lineCost)
    /* Shipping is split across every line by value. */
    line.shipping_share = round2(line.shipping_share + (goodsTotal > 0 ? shippingTotal * lineCost / goodsTotal : 0))
    const bought = `${i.qty} × ${i.variant_title ?? ""}`.trim()
    line.sizes_bought.push(bought)
  }

  const sortedGroups = [...groups.values()]
    .map((g) => ({ ...g, lines: g.lines.sort((a, b) => a.product.localeCompare(b.product)) }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.sort_order - b.sort_order || a.tier.localeCompare(b.tier))

  const savedRaw = (order?.metadata as Record<string, any> | null)?.packaging_plan
  const plan: SavedPlan | null = savedRaw && typeof savedRaw === "object" ? savedRaw as SavedPlan : null
  const remembered = (customer?.metadata as Record<string, any> | null)?.packaging_prices
  return {
    order: { id: order.id, display_id: order.display_id ?? null, created_at: order.created_at },
    default_usable_grams_per_unit: settings.usable_grams_per_unit,
    sizes,
    shipping_total: round2(shippingTotal),
    groups: sortedGroups,
    plan,
    remembered_prices: remembered && typeof remembered === "object" ? remembered : {},
  }
}

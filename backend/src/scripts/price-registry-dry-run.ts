import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { applyGroupPrices, type PlannedPrice } from "../lib/group-prices-apply"
import { applyOwnerPrices } from "../lib/owner-prices-apply"
import { GROUP_LEVEL_CONFIG, GROUP_LEVELS, OWNER_LEVEL_CONFIG, tableFor, type PriceLevel } from "../lib/price-levels"
import { loadProfiles } from "../lib/profile-store"
import { POST as tierApply } from "../api/admin/mbs/settings/tier-prices/apply/route"

/**
 * Read-only check for the price-table registry (zero-code categories,
 * Phase 2). Dry-runs every price apply for every table the category
 * profiles name and compares what it would write with what is stored:
 *
 *   - changed: the apply would write a different amount
 *   - added:   the apply would price a variant that has no price at that
 *              level yet
 *   - dropped: a PriceList price no table at that level would write any
 *              more (the apply leaves it alone, but it would go stale)
 *
 * All three empty means deploying the registry and pressing Save & Apply
 * changes no price. Writes nothing.
 *
 *   medusa exec ./src/scripts/price-registry-dry-run.ts
 */
export default async function priceRegistryDryRun({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const pricingService: any = container.resolve(Modules.PRICING)
  const { profiles, source } = await loadProfiles(container)
  logger.info(`profiles (${source}): ${profiles.map((p) => p.key).join(", ")}`)

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "title", "product.title"],
    filters: { deleted_at: null },
  })
  const label = new Map<string, string>()
  for (const v of variants as any[]) label.set(String(v.id), `${v.sku ?? "(no sku)"} · ${v.product?.title ?? ""} · ${v.title}`)

  const tablesAt = (level: PriceLevel) =>
    [...new Set(profiles.map((p) => tableFor(p, level)).filter((k): k is string => !!k))]

  const report: Record<string, unknown> = {}
  let problems = 0

  const compare = (name: string, summary: unknown, planned: PlannedPrice[]) => {
    const changed = planned.filter((p) => p.current != null && Math.abs(p.current - p.amount) > 0.005)
    const added = planned.filter((p) => p.current == null)
    problems += changed.length + added.length
    report[name] = {
      summary,
      planned: planned.length,
      changed: changed.map((p) => `${label.get(p.variant_id)}: ${p.current} → ${p.amount}`),
      added: added.map((p) => `${label.get(p.variant_id)}: → ${p.amount}`),
    }
  }

  /* Default (variant base price). */
  for (const table of tablesAt("default")) {
    let out: any = null
    const res: any = {
      status() { return res },
      json(body: any) { out = body; return res },
    }
    await tierApply({ body: { table, dryRun: true }, scope: container } as any, res)
    if (!out?.ok) { report[`default:${table}`] = { error: out?.message }; problems += 1; continue }
    compare(`default:${table}`, out.summary, out.planned ?? [])
  }

  /* Group levels + owner, then PriceList prices nothing plans any more. */
  const priceListPriceSets = async (title: string) => {
    const lists = await pricingService.listPriceLists({ title: [title] }, { take: 1 }).catch(() => [])
    if (!lists?.[0]?.id) return new Set<string>()
    const { data } = await query.graph({
      entity: "price_list",
      fields: ["id", "prices.price_set_id"],
      filters: { id: lists[0].id },
    })
    return new Set<string>(((data as any[])?.[0]?.prices ?? []).map((p: any) => String(p.price_set_id)))
  }
  const variantByPriceSet = new Map<string, string>()
  {
    const { data } = await query.graph({
      entity: "product_variant",
      fields: ["id", "price_set.id"],
      filters: { deleted_at: null },
    })
    for (const v of data as any[]) if (v.price_set?.id) variantByPriceSet.set(String(v.price_set.id), String(v.id))
  }
  const dropped = (name: string, existing: Set<string>, planned: Set<string>) => {
    const gone = [...existing].filter((id) => !planned.has(id))
    problems += gone.length
    report[`${name}:dropped`] = gone.map((id) => label.get(variantByPriceSet.get(id) ?? "") ?? `price_set ${id} (no live variant)`)
  }

  for (const group of GROUP_LEVELS) {
    const planned = new Set<string>()
    for (const table of tablesAt(group)) {
      const r = await applyGroupPrices(container, table, group, { dryRun: true })
      if (!r.ok) { report[`${group}:${table}`] = { error: r.error }; problems += 1; continue }
      compare(`${group}:${table}`, r.summary, r.planned ?? [])
      for (const p of r.planned ?? []) planned.add(p.price_set_id)
    }
    dropped(group, await priceListPriceSets(GROUP_LEVEL_CONFIG[group].priceListTitle), planned)
  }

  {
    const planned = new Set<string>()
    for (const table of tablesAt("owner")) {
      const r = await applyOwnerPrices(container, table, { dryRun: true })
      if (!r.ok) { report[`owner:${table}`] = { error: r.error }; problems += 1; continue }
      const { planned: list, ...summary } = r
      compare(`owner:${table}`, summary, list ?? [])
      for (const p of list ?? []) planned.add(p.price_set_id)
    }
    dropped("owner", await priceListPriceSets(OWNER_LEVEL_CONFIG.priceListTitle), planned)
  }

  logger.info(JSON.stringify(report, null, 2))
  logger.info(problems === 0 ? "✓ no price would change" : `✗ ${problems} differences — see report`)
}

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Read-only diagnostic — surveys every product + variant in the
 * catalog and reports which ones are missing `metadata.shipping_weight_lb`
 * (the field the ShipStation provider reads to quote rates at checkout).
 *
 * Use this to decide whether the 17-variant "16 skipped" gap is real
 * cleanup work or test-data that'll get replaced by real receivings.
 *
 * No writes — safe to run repeatedly. Output goes to logger so it shows
 * up alongside the rest of the Railway log stream.
 *
 * Usage:
 *   pnpm exec medusa exec ./src/scripts/audit-shipping-weights.ts
 */
export default async function auditShippingWeights({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "title", "handle", "status",
      "categories.name",
      "variants.id", "variants.title", "variants.sku", "variants.metadata",
    ],
    filters: { deleted_at: null },
  })

  const allProducts = (products as any[]) ?? []
  let totalVariants = 0
  let stampedVariants = 0
  const unstamped: Array<{ product: string; handle: string; categories: string; variant: string; sku: string | null; tierKey: string | null; sizeKey: string | null }> = []

  for (const p of allProducts) {
    const cats = (p.categories ?? []).map((c: any) => c.name).filter(Boolean).join(" / ") || "(uncategorized)"
    for (const v of p.variants ?? []) {
      totalVariants += 1
      const meta = (v.metadata ?? {}) as Record<string, any>
      const w = meta.shipping_weight_lb
      if (typeof w === "number" && Number.isFinite(w) && w > 0) {
        stampedVariants += 1
      } else {
        unstamped.push({
          product: p.title,
          handle: p.handle,
          categories: cats,
          variant: v.title,
          sku: v.sku ?? null,
          tierKey: typeof meta.tier_key === "string" ? meta.tier_key : null,
          sizeKey: typeof meta.size_key === "string" ? meta.size_key : null,
        })
      }
    }
  }

  logger.info("─────────────────────────────────────────────")
  logger.info(`SHIPPING-WEIGHTS AUDIT`)
  logger.info(`  Products: ${allProducts.length}`)
  logger.info(`  Variants: ${totalVariants}`)
  logger.info(`  ✓ Stamped:   ${stampedVariants}`)
  logger.info(`  ✗ Unstamped: ${unstamped.length}`)
  logger.info("─────────────────────────────────────────────")

  if (unstamped.length === 0) {
    logger.info("All variants have shipping_weight_lb — no cleanup needed.")
    return
  }

  /* Group by (categories, tier/size availability) so the report shows
   * patterns at a glance instead of one long flat list. */
  const byBucket = new Map<string, typeof unstamped>()
  for (const u of unstamped) {
    const bucket = `${u.categories} · tier_key=${u.tierKey ?? "(none)"} size_key=${u.sizeKey ?? "(none)"}`
    if (!byBucket.has(bucket)) byBucket.set(bucket, [])
    byBucket.get(bucket)!.push(u)
  }

  logger.info("Unstamped variants grouped by category + metadata shape:")
  for (const [bucket, rows] of byBucket.entries()) {
    logger.info(`  ── ${bucket} (${rows.length})`)
    for (const r of rows) {
      logger.info(`     · ${r.product} → ${r.variant}  (handle: ${r.handle}, sku: ${r.sku ?? "—"})`)
    }
  }

  logger.info("─────────────────────────────────────────────")
  /* Heuristic notes the operator can use to decide next steps. */
  const haveTierAndSize = unstamped.filter((u) => u.tierKey && u.sizeKey).length
  const haveNeither     = unstamped.filter((u) => !u.tierKey && !u.sizeKey).length
  logger.info(`  ${haveTierAndSize} unstamped variants HAVE tier_key + size_key (re-running Apply to All should catch these — `)
  logger.info(`    most likely the matching shipping_weights entry is missing from settings)`)
  logger.info(`  ${haveNeither} unstamped variants have NEITHER tier_key NOR size_key (legacy seed products — need title-`)
  logger.info(`    based fallback or manual edit; the standard Apply to All will keep skipping these)`)
}

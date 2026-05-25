import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Path-A migration step 1 — copy existing `variant.weight` (legacy: net
 * flower grams) into `variant.metadata.net_grams`. After this lands, the
 * storefront adapter reads net_grams from metadata, freeing variant.weight
 * to be repurposed as PACKAGED shipping grams (for ShipStation rate quotes).
 *
 * Idempotent: skips variants that already have metadata.net_grams set, or
 * that have no variant.weight to copy (nothing to preserve). Dry-run by
 * default; pass APPLY=1 to actually write.
 *
 * Run BEFORE the bulk-apply endpoint starts writing packaged grams to
 * variant.weight, otherwise the legacy net-gram data gets overwritten and
 * the storefront's per-gram pricing breaks.
 *
 * Usage:
 *   pnpm exec medusa exec ./src/scripts/backfill-net-grams.ts
 *   APPLY=1 pnpm exec medusa exec ./src/scripts/backfill-net-grams.ts
 */
export default async function backfillNetGrams({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const productService: any = container.resolve(Modules.PRODUCT)
  const apply = process.env.APPLY === "1"

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "title", "weight", "metadata"],
    filters: { deleted_at: null },
  })

  const all = (variants as any[]) ?? []
  const candidates: Array<{ id: string; title: string; weight: number; metadata: Record<string, any> }> = []
  let skippedAlready = 0
  let skippedNoWeight = 0

  for (const v of all) {
    const w = Number(v.weight ?? 0)
    if (!Number.isFinite(w) || w <= 0) {
      skippedNoWeight += 1
      continue
    }
    const meta = (v.metadata ?? {}) as Record<string, any>
    if (meta.net_grams != null) {
      skippedAlready += 1
      continue
    }
    candidates.push({ id: v.id, title: v.title ?? "", weight: w, metadata: meta })
  }

  logger.info("─────────────────────────────────")
  logger.info(`BACKFILL: variant.weight → variant.metadata.net_grams`)
  logger.info(`  Variants total:        ${all.length}`)
  logger.info(`  Already have net_grams: ${skippedAlready}`)
  logger.info(`  No weight to copy:      ${skippedNoWeight}`)
  logger.info(`  Will write:             ${candidates.length}`)
  logger.info("─────────────────────────────────")

  if (candidates.length === 0) {
    logger.info("Nothing to backfill.")
    return
  }

  if (!apply) {
    logger.info("DRY RUN — re-run with APPLY=1 to actually write.")
    for (const c of candidates.slice(0, 10)) {
      logger.info(`  · ${c.id} (${c.title}) weight=${c.weight}`)
    }
    if (candidates.length > 10) logger.info(`  · …and ${candidates.length - 10} more`)
    return
  }

  logger.warn("▶ APPLY=1 — writing in 3s. Cancel now if wrong.")
  await new Promise((r) => setTimeout(r, 3000))

  let ok = 0, fail = 0
  for (const c of candidates) {
    try {
      await productService.updateProductVariants(c.id, {
        metadata: { ...c.metadata, net_grams: c.weight },
      })
      ok += 1
    } catch (e: any) {
      logger.warn(`  ! variant ${c.id} update failed: ${e?.message}`)
      fail += 1
    }
  }

  logger.info(`✓ Backfilled net_grams on ${ok} variant(s) (${fail} failed).`)
  logger.info(`  Storefront per-gram pricing will keep working after`)
  logger.info(`  the bulk-apply repurposes variant.weight for ShipStation.`)
}

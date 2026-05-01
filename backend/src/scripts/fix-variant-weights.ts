import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Backfill `weight` (grams) on every Flower variant that's missing it.
 * The storefront margin calc requires weight to be set; manually-
 * created products often have it blank.
 *
 * Detects the size from the variant's `Size` option value:
 *   "qp (1/4lb)"    → 113g
 *   "half (1/2lb)"  → 227g
 *   "full (1lb)"    → 454g
 * Other size labels are skipped (with a warning) so we don't guess.
 *
 * Idempotent — only writes weight on variants where it's currently
 * null. Won't overwrite operator-set custom weights.
 *
 * Run: pnpm fix:variant-weights
 */

const SIZE_TO_GRAMS: Array<{ match: (v: string) => boolean; grams: number; label: string }> = [
  { match: (v) => /qp|1\/4/i.test(v),        grams: 113, label: "qp"   },
  { match: (v) => /half|1\/2/i.test(v),      grams: 227, label: "half" },
  { match: (v) => /full|1lb|^lb/i.test(v),   grams: 454, label: "lb"   },
]

function detectGrams(sizeValue: string): { grams: number; label: string } | null {
  for (const rule of SIZE_TO_GRAMS) {
    if (rule.match(sizeValue)) return { grams: rule.grams, label: rule.label }
  }
  return null
}

export default async function fixVariantWeights({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "variants.id",
      "variants.title",
      "variants.weight",
      "variants.options.value",
      "variants.options.option.title",
    ],
  })

  if (!products?.length) {
    logger.info("No products found.")
    return
  }

  let updated = 0
  let skippedHasWeight = 0
  let skippedUnknownSize = 0

  for (const p of products as any[]) {
    for (const v of p.variants ?? []) {
      if (v.weight != null) {
        skippedHasWeight += 1
        continue
      }
      const sizeOpt = (v.options ?? []).find(
        (o: any) => (o.option?.title ?? "").toLowerCase() === "size",
      ) ?? v.options?.[0]
      const sizeValue: string = sizeOpt?.value ?? ""
      const detected = detectGrams(sizeValue)
      if (!detected) {
        logger.warn(`  ? ${p.title} / ${v.title}: can't detect size from "${sizeValue}" — skipped`)
        skippedUnknownSize += 1
        continue
      }
      try {
        await updateProductVariantsWorkflow(container).run({
          input: {
            selector: { id: v.id },
            update: { weight: detected.grams },
          },
        })
        logger.info(`  + ${p.title.padEnd(28)} ${v.title.padEnd(20)} → ${detected.grams}g (${detected.label})`)
        updated += 1
      } catch (e: any) {
        logger.error(`  ✗ ${p.title} / ${v.title}: ${e?.message}`)
      }
    }
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ updated:           ${updated}`)
  logger.info(`· already had weight: ${skippedHasWeight}`)
  logger.info(`? unknown size:       ${skippedUnknownSize}`)
}

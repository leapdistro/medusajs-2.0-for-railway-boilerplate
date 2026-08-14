import type { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"
import { MBS_ATTRIBUTES_MODULE } from "../modules/mbs-attributes"

/**
 * Placeholder CBD + CBG SKUs — one strain per tier per branch (10 total).
 * Populates the CBD + CBG category tiles + PDPs on the storefront while
 * real inventory is still being sourced. Delete via wipe:catalog or the
 * standard Medusa admin once real product lands.
 *
 * Prereqs (run in this order first, once):
 *   pnpm seed:flower-cannabinoid-cats   ← creates flower-cbd + flower-cbg + tier children
 *   pnpm medusa db:generate mbs-attributes && pnpm medusa db:migrate
 *                                        ← adds cbd_percent / cbg_percent columns
 *
 * Idempotent: skips any product whose handle already exists.
 *
 * Run: pnpm seed:cbd-cbg-placeholders
 */

type Placeholder = {
  slug: string
  name: string
  branch: "cbd" | "cbg"
  /** Tier handle SUFFIX. Full category handle = `${branch}-${tierSuffix}`
   *  (matches seed-flower-cannabinoid-cats.ts naming). */
  tierSuffix: "classic" | "exotic" | "super" | "snowcaps" | "rapper"
  strain: "Indica" | "Sativa" | "Hybrid"
  bestFor: "day" | "evening" | "night"
  potency: 1 | 2 | 3
  cannabinoidPercent: string   // primary — CBD % for cbd branch, CBG % for cbg
  thcaPercent: string          // co-reported on the COA; drives compliance line
  d9Percent: string            // Δ9-THC value; drives (THCA × 0.877 + D9) < 0.3% line
  totalCannabinoidsPercent: string
  effects: string[]
}

const PLACEHOLDERS: Placeholder[] = [
  /* CBD — 5 tiers */
  { slug: "cbd-mountain-mist",   name: "Mountain Mist",   branch: "cbd", tierSuffix: "classic",  strain: "Hybrid",  bestFor: "evening", potency: 1, cannabinoidPercent: "14.2", thcaPercent: "0.10", d9Percent: "0.05", totalCannabinoidsPercent: "16.8", effects: ["Chill", "Relief"] },
  { slug: "cbd-lavender-dream",  name: "Lavender Dream",  branch: "cbd", tierSuffix: "exotic",   strain: "Indica",  bestFor: "night",   potency: 2, cannabinoidPercent: "16.8", thcaPercent: "0.12", d9Percent: "0.06", totalCannabinoidsPercent: "19.1", effects: ["Sleep", "Calm"] },
  { slug: "cbd-morning-sun",     name: "Morning Sun",     branch: "cbd", tierSuffix: "super",    strain: "Sativa",  bestFor: "day",     potency: 2, cannabinoidPercent: "18.4", thcaPercent: "0.15", d9Percent: "0.07", totalCannabinoidsPercent: "20.5", effects: ["Focus", "Energy"] },
  { slug: "cbd-snow-flower",     name: "Snow Flower",     branch: "cbd", tierSuffix: "snowcaps", strain: "Hybrid",  bestFor: "evening", potency: 3, cannabinoidPercent: "20.1", thcaPercent: "0.18", d9Percent: "0.08", totalCannabinoidsPercent: "22.7", effects: ["Grounded", "Relief"] },
  { slug: "cbd-crown-royal",     name: "Crown Royal",     branch: "cbd", tierSuffix: "rapper",   strain: "Sativa",  bestFor: "day",     potency: 3, cannabinoidPercent: "22.5", thcaPercent: "0.20", d9Percent: "0.09", totalCannabinoidsPercent: "24.9", effects: ["Creative", "Social"] },
  /* CBG — 5 tiers */
  { slug: "cbg-silver-haze",     name: "Silver Haze",     branch: "cbg", tierSuffix: "classic",  strain: "Sativa",  bestFor: "day",     potency: 1, cannabinoidPercent: "12.8", thcaPercent: "0.10", d9Percent: "0.05", totalCannabinoidsPercent: "15.2", effects: ["Focus", "Energy"] },
  { slug: "cbg-white-widow",     name: "White Widow",     branch: "cbg", tierSuffix: "exotic",   strain: "Hybrid",  bestFor: "evening", potency: 2, cannabinoidPercent: "15.4", thcaPercent: "0.14", d9Percent: "0.06", totalCannabinoidsPercent: "17.8", effects: ["Chill", "Grounded"] },
  { slug: "cbg-golden-hour",     name: "Golden Hour",     branch: "cbg", tierSuffix: "super",    strain: "Sativa",  bestFor: "day",     potency: 2, cannabinoidPercent: "17.2", thcaPercent: "0.15", d9Percent: "0.07", totalCannabinoidsPercent: "19.6", effects: ["Creative", "Social"] },
  { slug: "cbg-arctic-fox",      name: "Arctic Fox",      branch: "cbg", tierSuffix: "snowcaps", strain: "Indica",  bestFor: "night",   potency: 3, cannabinoidPercent: "19.5", thcaPercent: "0.18", d9Percent: "0.08", totalCannabinoidsPercent: "21.8", effects: ["Sleep", "Calm"] },
  { slug: "cbg-diamond-kush",    name: "Diamond Kush",    branch: "cbg", tierSuffix: "rapper",   strain: "Hybrid",  bestFor: "evening", potency: 3, cannabinoidPercent: "21.7", thcaPercent: "0.20", d9Percent: "0.09", totalCannabinoidsPercent: "24.3", effects: ["Grounded", "Relief"] },
]

/* Match sizeLabel convention used by seed-mbs.ts so admin display matches
 * the rest of the Flower catalog. */
const SIZE_LABELS: Record<string, string> = {
  qp:   "qp (1/4lb)",
  half: "half (1/2lb)",
  lb:   "full (1lb)",
}

/* Placeholder tier prices — mirror seed-mbs defaults; real prices come
 * from mbs-settings > flower_cbd_prices / flower_cbg_prices at resolve
 * time (calculated_price on the storefront). These are the raw base
 * prices Medusa needs to accept the create call. */
const PLACEHOLDER_PRICE_USD: Record<string, number> = { qp: 200, half: 375, lb: 700 }

export default async function seedCbdCbgPlaceholders({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link   = container.resolve(ContainerRegistrationKeys.LINK)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const mbsAttrs: any = container.resolve(MBS_ATTRIBUTES_MODULE)
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL)

  logger.info("=== CBD + CBG placeholder seed starting ===")

  const [defaultChannel] = await salesChannelService.listSalesChannels({
    name: "Default Sales Channel",
  })
  if (!defaultChannel) {
    throw new Error(
      "Default Sales Channel not found. Run the template's base seed first (`pnpm seed`).",
    )
  }

  /* Load ALL categories once — we'll look up each tier by its exact
   * handle (cbd-classic, cbg-exotic, …). Handles are globally unique
   * so a single scan disambiguates every branch. */
  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id"],
  })
  const byHandle = new Map<string, { id: string }>()
  for (const c of allCats as Array<{ id: string; handle?: string }>) {
    if (c.handle) byHandle.set(c.handle, { id: c.id })
  }

  let created = 0
  let skipped = 0
  let missingCategory = 0

  for (const p of PLACEHOLDERS) {
    const tierHandle = `${p.branch}-${p.tierSuffix}`
    const tierCat = byHandle.get(tierHandle)
    if (!tierCat) {
      logger.error(
        `  ✗ ${p.slug}: tier category ${tierHandle} missing. Run \`pnpm seed:flower-cannabinoid-cats\` first.`,
      )
      missingCategory += 1
      continue
    }

    /* Skip if product handle already exists — idempotent re-runs. */
    const { data: existing } = await query.graph({
      entity: "product",
      fields: ["id", "handle"],
      filters: { handle: p.slug },
    })
    if (existing.length > 0) {
      logger.info(`  · ${p.slug}: already exists — skipping`)
      skipped += 1
      continue
    }

    const weights = ["qp", "half", "lb"]
    const sizeValues = weights.map((w) => SIZE_LABELS[w])
    const variants = weights.map((w) => ({
      title: SIZE_LABELS[w],
      sku: `${p.slug.toUpperCase()}-${w.toUpperCase()}`,
      options: { Size: SIZE_LABELS[w] },
      prices: [{ amount: PLACEHOLDER_PRICE_USD[w], currency_code: "usd" }],
      /* Placeholders don't track inventory — receiving-driven products do.
       * Operator can flip manage_inventory on individual variants later
       * when real stock arrives. */
      manage_inventory: false,
    }))

    const { result } = await createProductsWorkflow(container).run({
      input: {
        products: [{
          title: p.name,
          handle: p.slug,
          status: ProductStatus.PUBLISHED,
          category_ids: [tierCat.id],
          options: [{ title: "Size", values: sizeValues }],
          variants,
          sales_channels: [{ id: defaultChannel.id }],
        }],
      },
    })
    const productId = result[0].id

    /* Attributes payload — populates the branch-specific cannabinoid
     * column (cbd_percent / cbg_percent) so the storefront's adapter
     * hits its preferred read path. thca_percent + d9_percent are
     * co-reported for the Texas total-THC compliance line. */
    const attrPayload: Record<string, any> = {
      strain_type: p.strain,
      best_for: p.bestFor,
      potency: p.potency,
      effects: p.effects,
      total_cannabinoids_percent: p.totalCannabinoidsPercent,
      thca_percent: p.thcaPercent,
      d9_percent: p.d9Percent,
      coa_url: null,
    }
    if (p.branch === "cbd") attrPayload.cbd_percent = p.cannabinoidPercent
    if (p.branch === "cbg") attrPayload.cbg_percent = p.cannabinoidPercent

    const attrs = await mbsAttrs.createProductAttributes(attrPayload)
    await link.create({
      [Modules.PRODUCT]: { product_id: productId },
      [MBS_ATTRIBUTES_MODULE]: { product_attributes_id: attrs.id },
    })

    logger.info(`  + ${p.slug}: created in ${tierHandle}`)
    created += 1
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ created: ${created}`)
  logger.info(`· skipped (already existed): ${skipped}`)
  if (missingCategory > 0) {
    logger.warn(`! missing category (skipped): ${missingCategory} — run seed:flower-cannabinoid-cats and retry`)
  }
  logger.info("Done.")
}

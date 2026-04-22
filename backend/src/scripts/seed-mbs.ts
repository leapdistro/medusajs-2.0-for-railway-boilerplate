import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows"
import { MBS_ATTRIBUTES_MODULE } from "../modules/mbs-attributes"
import {
  MBS_PRODUCTS,
  MbsSeedProduct,
  Tier,
} from "./data/mbs-products"

const TIER_LABELS: Record<Tier, string> = {
  classic: "Classic",
  exotic:  "Exotic",
  super:   "Super",
  rapper:  "Rapper",
  snow:    "Snowcaps",
}

// Storefront Size values — matches what the user entered in admin on 2026-04-21.
const SIZE_LABELS: Record<string, string> = {
  qp:         "qp (1/4lb)",
  half:       "half (1/2lb)",
  lb:         "full (1lb)",
  "box of 30": "box of 30",
  "box of 15": "box of 15",
}

// Placeholder wholesale prices in USD cents. Replace with real Price Lists later.
const FLOWER_PRICES_USD_CENTS: Record<string, number> = {
  qp:   20000,  // $200.00
  half: 37500,  // $375.00
  lb:   70000,  // $700.00
}
const PRE_ROLL_PRICE_USD_CENTS = 20000

const CATEGORY_TREE: { parent: string; children: string[] }[] = [
  { parent: "Flower",    children: ["Classic", "Exotic", "Super", "Rapper", "Snowcaps"] },
  { parent: "Pre-Rolls", children: ["THC-A", "Hashholes"] },
]

function sizeLabel(weight: string): string {
  return SIZE_LABELS[weight] ?? weight
}

function variantSku(slug: string, weight: string): string {
  const weightPart = weight.replace(/\s+/g, "-").toUpperCase()
  return `${slug.toUpperCase()}-${weightPart}`
}

function priceCentsFor(p: MbsSeedProduct, weight: string): number {
  if (p.category === "flower") return FLOWER_PRICES_USD_CENTS[weight] ?? 0
  return PRE_ROLL_PRICE_USD_CENTS
}

function childCategoryLabelFor(p: MbsSeedProduct): string {
  if (p.category === "flower") return TIER_LABELS[p.tier]
  return p.name.toLowerCase().includes("hashhole") ? "Hashholes" : "THC-A"
}

function parentCategoryLabelFor(p: MbsSeedProduct): string {
  return p.category === "flower" ? "Flower" : "Pre-Rolls"
}

export default async function seedMbsProducts({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link   = container.resolve(ContainerRegistrationKeys.LINK)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const mbsService: any = container.resolve(MBS_ATTRIBUTES_MODULE)
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL)

  logger.info("=== MBS Seed starting ===")

  const [defaultChannel] = await salesChannelService.listSalesChannels({
    name: "Default Sales Channel",
  })
  if (!defaultChannel) {
    throw new Error(
      "Default Sales Channel not found. Run the template's base seed first (`pnpm seed`)."
    )
  }

  logger.info("Ensuring category tree...")
  const categories = await ensureCategoryTree(container, query, logger)

  logger.info(`Processing ${MBS_PRODUCTS.length} products...`)
  let created = 0
  let updated = 0

  for (const p of MBS_PRODUCTS) {
    const parentLabel = parentCategoryLabelFor(p)
    const childLabel = childCategoryLabelFor(p)
    const childKey = `${parentLabel}/${childLabel}`
    const childCat = categories[childKey]
    if (!childCat) {
      logger.error(`  ✗ ${p.slug}: missing category ${childKey}`)
      continue
    }

    const { data: existing } = await query.graph({
      entity: "product",
      fields: ["id", "handle", "product_attributes.id"],
      filters: { handle: p.slug },
    })

    let productId: string
    let existingAttrsId: string | undefined

    if (existing.length > 0) {
      productId = existing[0].id
      existingAttrsId = (existing[0] as any).product_attributes?.id
      logger.info(`  · ${p.slug}: exists — upserting attributes only`)
    } else {
      const sizeValues = p.weights.map(sizeLabel)
      const variants = p.weights.map((w) => {
        const v = sizeLabel(w)
        return {
          title: v,
          sku: variantSku(p.slug, w),
          options: { Size: v },
          prices: [{ amount: priceCentsFor(p, w), currency_code: "usd" }],
          manage_inventory: false,
        }
      })

      const { result } = await createProductsWorkflow(container).run({
        input: {
          products: [{
            title: p.name,
            handle: p.slug,
            status: ProductStatus.PUBLISHED,
            category_ids: [childCat.id],
            options: [{ title: "Size", values: sizeValues }],
            variants,
            sales_channels: [{ id: defaultChannel.id }],
          }],
        },
      })
      productId = result[0].id
      created += 1
      logger.info(`  + ${p.slug}: created in ${childKey}`)
    }

    const attrPayload = {
      tier: p.tier,
      strain_type: p.strain,
      best_for: p.bestFor,
      potency: p.potency,
      thca_percent: p.thcaPercent,
      total_cannabinoids_percent: p.cannabinoidsPercent,
      effects: p.effects,
      coa_url: `/coas/${p.slug}.pdf`,
    }

    if (existingAttrsId) {
      await mbsService.updateProductAttributes({ id: existingAttrsId, ...attrPayload })
    } else {
      const newAttrs = await mbsService.createProductAttributes(attrPayload)
      await link.create({
        [Modules.PRODUCT]: { product_id: productId },
        [MBS_ATTRIBUTES_MODULE]: { product_attributes_id: newAttrs.id },
      })
    }
    updated += 1
  }

  logger.info(`=== MBS Seed complete: ${created} created, ${updated} attribute upserts ===`)
}

async function ensureCategoryTree(
  container: any,
  query: any,
  logger: any,
): Promise<Record<string, { id: string }>> {
  const out: Record<string, { id: string }> = {}

  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })

  for (const branch of CATEGORY_TREE) {
    let parentCat = allCats.find(
      (c: any) => c.name === branch.parent && !c.parent_category_id
    )

    if (!parentCat) {
      const { result } = await createProductCategoriesWorkflow(container).run({
        input: {
          product_categories: [{ name: branch.parent, is_active: true }],
        },
      })
      parentCat = result[0]
      logger.info(`  + category ${branch.parent}`)
    }

    for (const childName of branch.children) {
      let childCat = allCats.find(
        (c: any) => c.name === childName && c.parent_category_id === parentCat!.id
      )

      if (!childCat) {
        const { result } = await createProductCategoriesWorkflow(container).run({
          input: {
            product_categories: [{
              name: childName,
              is_active: true,
              parent_category_id: parentCat!.id,
            }],
          },
        })
        childCat = result[0]
        logger.info(`  + category ${branch.parent}/${childName}`)
      }

      out[`${branch.parent}/${childName}`] = { id: childCat!.id }
    }
  }

  return out
}

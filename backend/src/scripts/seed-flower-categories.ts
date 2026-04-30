import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createProductCategoriesWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Idempotent: ensures the Flower category tree exists without
 * recreating the 12 sample products that seed:mbs.ts also writes.
 * Use this before the first receiving if `pnpm seed:mbs` was never
 * run on a clean DB (or if categories were wiped).
 *
 * Run: pnpm seed:flower-categories
 */

const FLOWER_CATEGORIES = ["Classic", "Exotic", "Super", "Rapper", "Snowcaps"]

export default async function seedFlowerCategories({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })

  let parent = (allCats as any[]).find((c) => c.name === "Flower" && !c.parent_category_id)
  if (!parent) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: { product_categories: [{ name: "Flower", is_active: true }] },
    })
    parent = result[0]
    logger.info(`+ Flower (parent)`)
  } else {
    logger.info(`· Flower already exists`)
  }

  let created = 0
  for (const childName of FLOWER_CATEGORIES) {
    const exists = (allCats as any[]).some(
      (c) => c.name === childName && c.parent_category_id === parent.id,
    )
    if (exists) {
      logger.info(`  · ${childName}`)
      continue
    }
    await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: [{
          name: childName,
          is_active: true,
          parent_category_id: parent.id,
        }],
      },
    })
    logger.info(`  + ${childName}`)
    created += 1
  }

  logger.info(`Done. Created ${created} new sub-categories.`)
}

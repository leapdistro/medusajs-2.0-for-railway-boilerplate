import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createProductCategoriesWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Idempotent: creates the Pre-Rolls category tree without recreating
 * any sample products. Mirror of seed-flower-categories.ts.
 *
 *   Pre-Rolls
 *     ├── THC-A      (box of 30, 1.5g each)
 *     └── Hashholes  (box of 15, 2/tube)
 *
 * Run: pnpm seed:preroll-categories
 */

const PREROLL_SUBCATS = ["THC-A", "Hashholes"]

export default async function seedPrerollCategories({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: allCats } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "parent_category_id"],
  })

  let parent = (allCats as any[]).find((c) => c.name === "Pre-Rolls" && !c.parent_category_id)
  if (!parent) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: { product_categories: [{ name: "Pre-Rolls", is_active: true }] },
    })
    parent = result[0]
    logger.info(`+ Pre-Rolls (parent)`)
  } else {
    logger.info(`· Pre-Rolls already exists`)
  }

  let created = 0
  for (const childName of PREROLL_SUBCATS) {
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

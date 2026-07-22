import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow,
  updateProductCategoriesWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Splits the Flower category into THC-A and THC-P branches.
 *
 * End state:
 *   Flower
 *     ├── THC-A
 *     │     ├── Classic
 *     │     ├── Exotic
 *     │     ├── Super
 *     │     ├── Snowcaps
 *     │     └── Rapper
 *     └── THC-P
 *
 * Operations (all idempotent — safe to re-run):
 *   1. Ensure THC-A exists under Flower.
 *   2. Reparent the 5 tier categories from Flower → THC-A.
 *   3. Ensure THC-P exists under Flower.
 *
 * URLs stay flat on the storefront: /products/flower/<tier>/<handle>
 * continues to work; router aliases /flower/<tier> to /flower/thc-a/<tier>.
 *
 * Run: pnpm seed:flower-cannabinoid-cats
 */

const TIER_NAMES = ["Classic", "Exotic", "Super", "Snowcaps", "Rapper"]

export default async function seedFlowerCannabinoidCats({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const readAll = async () => {
    const { data } = await query.graph({
      entity: "product_category",
      fields: ["id", "name", "parent_category_id"],
    })
    return data as Array<{ id: string; name: string; parent_category_id: string | null }>
  }

  let allCats = await readAll()

  const flower = allCats.find((c) => c.name === "Flower" && !c.parent_category_id)
  if (!flower) {
    throw new Error(
      `"Flower" parent category not found. Run \`pnpm seed:flower-categories\` first.`,
    )
  }

  /* Step 1 — ensure THC-A exists under Flower.
   *   Handle MUST be "flower-thc-a" (not "thc-a"): Medusa product_category
   *   handles are globally unique, and Pre-Rolls > THC-A already owns
   *   "thc-a". Since this THC-A intermediate node isn't user-clickable
   *   (it's just a section header on /products/flower), the handle is
   *   internal-only — code that walks the tree looks for it by handle
   *   `flower-thc-a`. */
  const THCA_HANDLE = "flower-thc-a"
  let thca = allCats.find((c) => c.name === "THC-A" && c.parent_category_id === flower.id)
  if (!thca) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: [{
          name: "THC-A",
          handle: THCA_HANDLE,
          is_active: true,
          parent_category_id: flower.id,
        }],
      },
    })
    thca = { id: result[0].id, name: "THC-A", parent_category_id: flower.id }
    logger.info(`+ Flower > THC-A created (${thca.id}, handle=${THCA_HANDLE})`)
  } else {
    logger.info(`· Flower > THC-A already exists (${thca.id})`)
  }

  /* Step 2 — reparent the 5 tier categories under THC-A */
  allCats = await readAll()
  let reparented = 0
  for (const tierName of TIER_NAMES) {
    /* Only reparent a tier that currently sits directly under Flower.
     * If it's already under THC-A we skip; if it's under something else
     * we skip and log so the operator can eyeball. */
    const tier = allCats.find((c) => c.name === tierName)
    if (!tier) {
      logger.warn(`  ! ${tierName} — not found, skipping`)
      continue
    }
    if (tier.parent_category_id === thca.id) {
      logger.info(`  · ${tierName} already under THC-A`)
      continue
    }
    if (tier.parent_category_id !== flower.id) {
      logger.warn(
        `  ! ${tierName} parent is ${tier.parent_category_id ?? "null"} (not Flower). Skipping to avoid clobbering.`,
      )
      continue
    }
    await updateProductCategoriesWorkflow(container).run({
      input: {
        selector: { id: tier.id },
        update: { parent_category_id: thca.id },
      },
    })
    logger.info(`  → ${tierName} reparented Flower → THC-A`)
    reparented += 1
  }

  /* Step 3 — ensure THC-P exists under Flower */
  allCats = await readAll()
  const thcp = allCats.find((c) => c.name === "THC-P" && c.parent_category_id === flower.id)
  if (!thcp) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: [{
          name: "THC-P",
          is_active: true,
          parent_category_id: flower.id,
        }],
      },
    })
    logger.info(`+ Flower > THC-P created (${result[0].id})`)
  } else {
    logger.info(`· Flower > THC-P already exists (${thcp.id})`)
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ Reparented ${reparented} tier categorie(s) under THC-A`)
  logger.info("Done.")
}

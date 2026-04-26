import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Link every product in the catalog to the default shipping profile.
 *
 * Why this exists: Medusa v2's cart.complete() requires that every cart
 * item's product is linked to a shipping profile that matches one of the
 * picked shipping option's profiles. Products created via the admin UI
 * (or by the legacy seed-mbs.ts) don't get this link automatically — you
 * see "The cart items require shipping profiles that are not satisfied
 * by the current shipping methods" at checkout.
 *
 * Idempotent: skips products that are already linked.
 *
 * Run via:  pnpm link:shipping-profile
 *
 * Phase 2 (Receiving system) will set this link automatically when
 * products are created from intake. This script is the bootstrap for
 * everything created by hand before then.
 */

export default async function linkShippingProfile({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link   = container.resolve(ContainerRegistrationKeys.LINK)
  const query  = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillmentService: any = container.resolve(Modules.FULFILLMENT)

  logger.info("▶ Linking products to default shipping profile…")

  // Find the default shipping profile.
  const profiles = await fulfillmentService.listShippingProfiles({ type: "default" })
  const profile = profiles?.[0]
  if (!profile) {
    logger.error("✗ No default shipping profile found. Run `pnpm seed:us` first.")
    return
  }
  logger.info(`  · default profile: ${profile.name} (${profile.id})`)

  // Pull every product with its existing shipping profile links.
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "title", "shipping_profile.id"],
  })
  if (!products?.length) {
    logger.info("  · no products to link")
    return
  }

  let linked = 0
  let skipped = 0
  for (const p of products) {
    const existing = (p as any).shipping_profile
    if (existing?.id === profile.id) {
      skipped += 1
      continue
    }
    try {
      await link.create({
        [Modules.PRODUCT]:     { product_id: p.id },
        [Modules.FULFILLMENT]: { shipping_profile_id: profile.id },
      })
      linked += 1
      logger.info(`  + linked ${(p as any).title} (${p.id})`)
    } catch (e: any) {
      // Duplicate-link errors mean already linked — quiet skip.
      if (!String(e?.message ?? "").toLowerCase().includes("duplicate")) {
        logger.warn(`  ! link failed for ${(p as any).title}: ${e?.message}`)
      } else {
        skipped += 1
      }
    }
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ linked:  ${linked}`)
  logger.info(`· skipped: ${skipped}`)
  logger.info("Done. Try Place Order again.")
}

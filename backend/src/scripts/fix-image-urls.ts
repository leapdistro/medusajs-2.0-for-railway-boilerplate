import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * One-off — rewrite raw `#` in stored image URLs to `%23`.
 *
 * Problem: strain names like "CANDY CARTEL #11" produce upload filenames
 * containing `#`. The `#` survives into the bucket key + the URL stored
 * in Medusa (`image.url`, `product.thumbnail`). When the storefront
 * renders `<img src="...#11...">`, the browser truncates at `#` (it's
 * the fragment delimiter) — the request 404s, the image disappears.
 *
 * Fix: rewrite raw `#` to `%23` in-place. The bucket file already lives
 * at the encoded URL (verified via curl), so no re-upload needed.
 *
 * Two tables touched:
 *   - image.url           (product image records)
 *   - product.thumbnail   (denormalized hero image on the product row)
 *
 * Idempotent: `LIKE '%#%'` only matches rows still containing raw `#`;
 * already-encoded `%23` doesn't match, so re-running is a no-op.
 *
 * Run: pnpm fix:image-urls
 */
export default async function fixImageUrls({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const pg: any = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  logger.info("▶ Rewriting raw `#` → `%23` in image URLs…")

  const imageRes = await pg.raw(
    `update "image" set url = replace(url, '#', '%23') where url like '%#%' returning id, url;`,
  )
  const imageRows = imageRes?.rows ?? imageRes ?? []
  logger.info(`✓ image table: ${imageRows.length} row(s) updated`)
  for (const r of imageRows) logger.info(`    ${r.id}  →  ${r.url}`)

  const thumbRes = await pg.raw(
    `update "product" set thumbnail = replace(thumbnail, '#', '%23') where thumbnail like '%#%' returning id, handle, thumbnail;`,
  )
  const thumbRows = thumbRes?.rows ?? thumbRes ?? []
  logger.info(`✓ product.thumbnail: ${thumbRows.length} row(s) updated`)
  for (const r of thumbRows) logger.info(`    ${r.handle.padEnd(28)} →  ${r.thumbnail}`)

  logger.info("Done.")
}

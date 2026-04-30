import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Lists every publishable API key and its sales channels. Use to
 * recover the key after a wipe/redeploy or to sanity-check that
 * the storefront's `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` matches
 * what Medusa thinks is current.
 *
 * Run: pnpm inspect:keys
 */
export default async function inspectKeys({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const apiKeyService: any = container.resolve(Modules.API_KEY)

  const keys = await apiKeyService.listApiKeys({ type: "publishable" })
  if (!keys.length) {
    logger.info("No publishable API keys found.")
    return
  }
  logger.info(`▶ ${keys.length} publishable API key(s)`)
  logger.info("─────────────────────────────────────────────────")
  for (const k of keys) {
    logger.info(`  · ${k.title || "(untitled)"}  id=${k.id}`)
    logger.info(`      token:    ${k.token}`)
    logger.info(`      revoked:  ${k.revoked_at ? "YES (" + k.revoked_at + ")" : "no"}`)
  }
  logger.info("─────────────────────────────────────────────────")
}

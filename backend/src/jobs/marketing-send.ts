import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { runMarketingQueue } from "../lib/marketing/send"

/** Starts scheduled marketing campaigns when due and resumes any that
 *  were interrupted mid-send (lib/marketing/send.ts). */
export default async function marketingSend(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const log = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m), error: (m: string) => logger.error(m) }
  try {
    await runMarketingQueue(container, log)
  } catch (e: any) {
    logger.warn(`[marketing-send] pass failed: ${e?.message}`)
  }
}

export const config = {
  name: "marketing-send",
  schedule: "* * * * *",
}

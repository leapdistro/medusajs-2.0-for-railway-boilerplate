import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { runDueSyncJobs } from "../lib/qbo-sync-queue"

/** Retries queued order → QBO syncs that are due (lib/qbo-sync-queue.ts). */
export default async function qboSyncRetry(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const log = { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m), error: (m: string) => logger.error(m) }
  try {
    const { ran, reset } = await runDueSyncJobs(container, log)
    if (ran || reset) logger.info(`[qbo-sync-retry] ran ${ran} job(s), reset ${reset} stuck`)
  } catch (e: any) {
    logger.warn(`[qbo-sync-retry] pass failed: ${e?.message}`)
  }
}

export const config = {
  name: "qbo-sync-retry",
  schedule: "* * * * *",
}

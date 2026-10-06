import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { planOrderSync } from "../lib/qbo-order-sync"

/**
 * Dry run of the QBO order sync across pushed orders — writes NOTHING
 * (no QBO writes, no order stamps). Prints the action each order would
 * get; the non-"unchanged" rows are the backfill list.
 *
 * Usage: SINCE=2026-05-01 pnpm qbo:sync-plan     (ORDERS=317,332 for specific display ids)
 */
export default async function qboSyncPlan({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const ids = (process.env.ORDERS ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean)
  const since = process.env.SINCE ?? "2026-01-01"
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "metadata", "created_at"],
    filters: ids.length ? { display_id: ids } : { created_at: { $gte: since } },
  })
  const orders = (data as any[]).filter((o) => o.metadata?.qbo_invoice_id).sort((a, b) => a.display_id - b.display_id)
  const quiet = { info: () => {}, warn: (m: string) => logger.warn(m), error: (m: string) => logger.warn(m) }
  const counts: Record<string, number> = {}
  for (const o of orders) {
    /* Throttle: the live backend shares QBO's per-company rate limit. */
    await new Promise((r) => setTimeout(r, 400))
    let line: string
    try {
      const r = await planOrderSync(container, o.id, quiet)
      const tag = r.ok === true ? r.action : `ERROR ${(r as any).code}`
      counts[tag] = (counts[tag] ?? 0) + 1
      line = r.ok === true ? r.message : (r as any).error
      if (tag !== "unchanged") console.log(`#${o.display_id}\tinv ${o.metadata.qbo_invoice_id}\t${tag}\t${line}`)
    } catch (e: any) {
      counts.EXCEPTION = (counts.EXCEPTION ?? 0) + 1
      console.log(`#${o.display_id}\tinv ${o.metadata.qbo_invoice_id}\tEXCEPTION\t${e?.message}`)
    }
  }
  console.log(`\n${orders.length} pushed orders checked:`, JSON.stringify(counts))
}

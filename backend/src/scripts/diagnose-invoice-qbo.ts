import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"
import { QBO_CONNECTION_MODULE } from "../modules/qbo-connection"
import { baseFromVariantSku, findItemBySku } from "../lib/qbo-api"

/**
 * Diagnose why a QBO invoice push fails on some orders and succeeds on
 * others. For every line item on the passed order display_ids, prints:
 *
 *   - line variant_sku, baseSku (what QBO gets queried with)
 *   - QBO Item resolution: found (id, name, SKU as stored in QBO) or MISSING
 *   - order.metadata.qbo_invoice_id + qbo_push_error
 *
 * When called with two display_ids (a working one + a failing one), it's
 * meant to answer "which SKUs differ?" — e.g., failing SKUs vs. the ones
 * QBO actually has stored.
 *
 * Run with:
 *   DIAG_DISPLAY_IDS='218,2291' pnpm exec medusa exec ./src/scripts/diagnose-invoice-qbo.ts
 */

const IDS = (process.env.DIAG_DISPLAY_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)

export default async function diagnoseInvoiceQbo({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  if (IDS.length === 0) {
    logger.error("❌ DIAG_DISPLAY_IDS env var required. Example: DIAG_DISPLAY_IDS='218,2291'")
    return
  }

  const qbo: any = container.resolve(QBO_CONNECTION_MODULE)
  const connRows = await qbo.listQboConnections({}, { take: 1 })
  const conn = connRows[0]
  if (!conn) {
    logger.error("❌ No QBO connection row — connect QBO first at /app/quickbooks")
    return
  }
  logger.info(`✓ QBO connection: env=${conn.environment} realm=${conn.realm_id}`)
  logger.info("")

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "metadata", "created_at",
      "items.id", "items.title", "items.product_title", "items.variant_sku",
      "items.variant.product.id",
      "items.variant.product.title",
      "items.variant.product.categories.id",
      "items.variant.product.categories.name",
      "items.variant.product.categories.handle",
      "items.variant.product.categories.parent_category_id",
    ],
    filters: { display_id: IDS.map((s) => Number(s)).filter((n) => Number.isFinite(n)) },
  })

  if (!orders?.length) {
    logger.error(`No orders found for display_ids=[${IDS.join(", ")}]`)
    return
  }

  /* Cross-invoice roll-up so we can see which SKUs overlap between orders. */
  const skuSeenIn: Record<string, string[]> = {}
  const skuStatus: Record<string, { found: boolean; qboId?: string; qboName?: string; qboSku?: string }> = {}

  for (const o of orders as any[]) {
    const oMeta = (o.metadata ?? {}) as Record<string, any>
    logger.info(`══ Order #${o.display_id} (${o.id}) ══`)
    logger.info(`  created_at:                       ${o.created_at}`)
    logger.info(`  metadata.qbo_invoice_id:          ${oMeta.qbo_invoice_id ?? "—"}`)
    logger.info(`  metadata.qbo_push_error:          ${oMeta.qbo_push_error ?? "—"}`)
    logger.info(`  items: ${(o.items ?? []).length}`)
    logger.info("")

    for (const item of ((o.items ?? []) as any[])) {
      const vSku = item.variant_sku as string | null
      const productTitle = item.product_title ?? item.title ?? "(untitled)"
      const cats = ((item.variant?.product?.categories ?? []) as Array<{
        name?: string; handle?: string; parent_category_id?: string | null
      }>)
        .map((c) => `${c.name ?? "?"}[${c.handle ?? "?"}]`)
        .join(" · ")

      logger.info(`  ─ ${productTitle}`)
      logger.info(`      line variant_sku: ${vSku ?? "❌ NONE"}`)
      if (!vSku) {
        logger.info(`      → SKIPPED (no SKU on line)`)
        continue
      }
      const baseSku = baseFromVariantSku(vSku)
      logger.info(`      baseSku (QBO lookup): ${baseSku}`)
      logger.info(`      product categories: ${cats || "(none)"}`)

      // Track cross-invoice
      if (!skuSeenIn[baseSku]) skuSeenIn[baseSku] = []
      skuSeenIn[baseSku].push(String(o.display_id))

      // QBO lookup — memoized across orders
      if (skuStatus[baseSku]) {
        const s = skuStatus[baseSku]
        logger.info(`      QBO Item: ${s.found ? `✓ ${s.qboId} "${s.qboName}" (stored SKU: ${s.qboSku})` : `❌ MISSING`} (cached)`)
      } else {
        try {
          const hit = await findItemBySku(qbo, conn, baseSku)
          if (hit) {
            /* Re-query to pull the actual stored Sku so we can spot
             * case / hyphen / prefix drift vs what we sent. */
            skuStatus[baseSku] = { found: true, qboId: hit.id, qboName: hit.name, qboSku: baseSku }
            logger.info(`      QBO Item: ✓ ${hit.id} "${hit.name}"`)
          } else {
            skuStatus[baseSku] = { found: false }
            logger.info(`      QBO Item: ❌ MISSING`)
          }
        } catch (e: any) {
          skuStatus[baseSku] = { found: false }
          logger.info(`      QBO Item: ❌ LOOKUP ERROR: ${e?.message}`)
        }
      }
      logger.info("")
    }
    logger.info("")
  }

  /* Summary — group SKUs by resolution status. */
  logger.info(`══ Summary ══`)
  const foundSkus = Object.entries(skuStatus).filter(([, s]) => s.found).map(([sku]) => sku)
  const missingSkus = Object.entries(skuStatus).filter(([, s]) => !s.found).map(([sku]) => sku)
  logger.info(`  Distinct baseSkus scanned: ${Object.keys(skuStatus).length}`)
  logger.info(`  Resolved in QBO: ${foundSkus.length}`)
  logger.info(`  Missing in QBO: ${missingSkus.length}`)
  if (missingSkus.length > 0) {
    logger.info("")
    logger.info(`  Missing SKUs:`)
    for (const sku of missingSkus) {
      logger.info(`    - ${sku}  (seen on order(s) ${skuSeenIn[sku].join(", ")})`)
    }
  }
  logger.info("")
  logger.info("══ End ══")
}

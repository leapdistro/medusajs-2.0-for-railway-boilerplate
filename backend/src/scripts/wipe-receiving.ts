import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows"
import { RECEIVING_HISTORY_MODULE } from "../modules/receiving-history"

/**
 * Roll back a receiving — delete every product, variant, and inventory
 * item created by it, then delete the receiving_history record itself.
 *
 * Usage:
 *   pnpm wipe:receiving                   # wipes the most recent receiving
 *   HISTORY_ID=<id> pnpm wipe:receiving   # wipes a specific receiving
 *   ALL=1 pnpm wipe:receiving             # WIPES EVERY RECEIVING (asks for confirmation)
 *
 * Restock receivings (action="restocked") only DECREMENT the pool —
 * they don't delete the product, since other receivings put inventory
 * there. The script logs what it does so you can verify.
 *
 * Use sparingly — this is a test-cycle convenience, not a regular
 * operator action. Real returns / corrections should go through a
 * proper adjustment flow (out of scope for v0).
 */
export default async function wipeReceiving({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const history: any = container.resolve(RECEIVING_HISTORY_MODULE)
  const inventoryService: any = container.resolve(Modules.INVENTORY)

  const wipeAll = process.env.ALL === "1"
  const explicitId = process.env.HISTORY_ID

  let records: any[]
  if (wipeAll) {
    records = await history.listReceivingRecords({}, { order: { created_at: "DESC" } })
    if (records.length === 0) {
      logger.info("No receiving records to wipe.")
      return
    }
    logger.warn(`▶ ALL=1 — will wipe ${records.length} receivings. Cancel within 3s if wrong.`)
    await new Promise((r) => setTimeout(r, 3000))
  } else if (explicitId) {
    const r = await history.retrieveReceivingRecord(explicitId).catch(() => null)
    if (!r) { logger.error(`✗ No receiving with id ${explicitId}`); return }
    records = [r]
  } else {
    const list = await history.listReceivingRecords({}, { order: { created_at: "DESC" }, take: 1 })
    if (list.length === 0) { logger.info("No receiving records found."); return }
    records = list
  }

  let totalProducts = 0
  let totalRestockDecrements = 0
  let totalInventoryItems = 0

  for (const record of records) {
    logger.info(`▶ Wiping receiving ${record.id} — invoice ${record.invoice_number} (${record.invoice_date})`)
    const lines = (record.line_results ?? []) as any[]

    /* 1. CREATE rows: delete the product (cascades to variants +
     *    links) and the inventory item. */
    const productIdsToDelete: string[] = []
    const inventoryItemIdsToDelete: string[] = []
    for (const line of lines) {
      if (line.action === "created" && line.productId) {
        productIdsToDelete.push(line.productId)
        if (line.inventoryItemId) inventoryItemIdsToDelete.push(line.inventoryItemId)
      }
    }
    if (productIdsToDelete.length > 0) {
      try {
        await deleteProductsWorkflow(container).run({ input: { ids: productIdsToDelete } })
        totalProducts += productIdsToDelete.length
        logger.info(`  - deleted ${productIdsToDelete.length} products`)
      } catch (e: any) {
        logger.error(`  ✗ product delete failed: ${e?.message}`)
      }
    }
    for (const invId of inventoryItemIdsToDelete) {
      try {
        await inventoryService.deleteInventoryItems([invId])
        totalInventoryItems += 1
      } catch (e: any) {
        logger.warn(`  ? inventory item ${invId} delete: ${e?.message}`)
      }
    }
    if (inventoryItemIdsToDelete.length > 0) {
      logger.info(`  - deleted ${inventoryItemIdsToDelete.length} inventory items`)
    }

    /* 2. RESTOCK rows: decrement the pool by what THIS receiving added.
     *    Don't delete the product — earlier receivings put stock there
     *    too and the product still has variants linked. */
    for (const line of lines) {
      if (line.action === "restocked" && line.inventoryItemId && line.qtyQps) {
        try {
          const levels = await inventoryService.listInventoryLevels({
            inventory_item_id: line.inventoryItemId,
          })
          for (const lvl of levels) {
            const newQty = Math.max(0, (lvl.stocked_quantity ?? 0) - (line.qtyQps ?? 0))
            await inventoryService.updateInventoryLevels([{
              id: lvl.id,
              stocked_quantity: newQty,
            }])
          }
          totalRestockDecrements += 1
        } catch (e: any) {
          logger.warn(`  ? restock decrement for ${line.strainName}: ${e?.message}`)
        }
      }
    }

    /* 3. Drop the history record itself. */
    try {
      await history.deleteReceivingRecords([record.id])
      logger.info(`  - deleted history record`)
    } catch (e: any) {
      logger.error(`  ✗ history delete failed: ${e?.message}`)
    }
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ wiped ${records.length} receiving(s)`)
  logger.info(`  · ${totalProducts} products deleted`)
  logger.info(`  · ${totalInventoryItems} inventory items deleted`)
  logger.info(`  · ${totalRestockDecrements} restock entries reverted`)
}

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  billPublicUrl,
  createBill,
  findOrCreateItem,
  findOrCreateVendor,
  getDefaultAccounts,
  resolveCategoryChain,
} from "../../../../lib/qbo-api"
import { QBO_CONNECTION_MODULE } from "../../../../modules/qbo-connection"
import { RECEIVING_HISTORY_MODULE } from "../../../../modules/receiving-history"

/* Legacy label map — only used as a fallback when line_results lacks
 * `tierLabel` (pre-2026-05-14 receivings). New receivings carry their
 * own subcategory display label so any profile (flower / pre-roll /
 * future) lands with the right text on QBO Item + line descriptions. */
const LEGACY_TIER_LABEL: Record<string, string> = {
  classic: "Classic",
  exotic: "Exotic",
  super: "Super",
  snow: "Snowcaps",
  rapper: "Rapper",
}

/**
 * POST /admin/qbo/push-bill { historyId }
 *
 * 1. Load the receiving_record by id.
 * 2. Connect to QBO using the single qbo_connection row (auto-refresh).
 * 3. Find-or-create vendor by supplier.name.
 * 4. For each successfully-saved line (action != "failed"), find-or-create
 *    a tier-aware Inventory Item ("{strain} · {Tier label}") and stage a
 *    Bill line at landedPerQp × qtyQps.
 * 5. POST the Bill, store qbo_bill_id + qbo_pushed_at on the receiving row
 *    and last_bill_id / last_bill_pushed_at on the connection.
 * 6. Return { ok, billId, billUrl }.
 *
 * Idempotency: if the receiving already has qbo_bill_id set, returns 409
 * with the existing id. Operator can disconnect+reconnect or wipe the field
 * if they really want to re-push.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)

  const body = (req.body ?? {}) as { historyId?: string }
  const historyId = body.historyId
  if (!historyId) {
    return res.status(400).json({ ok: false, error: "historyId is required" })
  }

  /* 1. Load the receiving record. */
  const record = await history.retrieveReceivingRecord(historyId).catch(() => null)
  if (!record) {
    return res.status(404).json({ ok: false, error: `No receiving with id ${historyId}` })
  }
  if (record.qbo_bill_id) {
    return res.status(409).json({
      ok: false,
      error: "Already pushed to QuickBooks",
      billId: record.qbo_bill_id,
      pushedAt: record.qbo_pushed_at,
    })
  }

  /* 2. Resolve the active QBO connection. */
  const connRows = await qbo.listQboConnections({}, { take: 1 })
  const conn = connRows[0]
  if (!conn) {
    return res.status(400).json({ ok: false, error: "QuickBooks is not connected. Visit /app/quickbooks → Connect first." })
  }

  /* 3. Vendor. */
  const supplier = (record.supplier ?? {}) as { name?: string; email?: string | null; phone?: string | null; address?: string | null }
  if (!supplier.name) {
    return res.status(400).json({ ok: false, error: "Receiving has no supplier.name — can't match vendor in QBO." })
  }

  /* 4. Pre-flight: default accounts (Inventory Asset, Income, COGS). */
  let accounts
  try {
    accounts = await getDefaultAccounts(qbo, conn)
  } catch (e: any) {
    logger.error(`[qbo/push-bill] chart of accounts lookup failed: ${e?.message}`)
    return res.status(500).json({ ok: false, error: e?.message ?? "QBO accounts lookup failed" })
  }

  try {
    const vendor = await findOrCreateVendor(qbo, conn, {
      name: supplier.name,
      email: supplier.email ?? null,
      phone: supplier.phone ?? null,
      address: supplier.address ?? null,
    })

    /* 5. Lines: one per successfully-saved row. */
    type LineResult = {
      strainName: string
      tier?: string
      tierLabel?: string                  // subcategory display label from receiving-save
      poolUnitLabel?: string              // multiplier-1 variant label (QP / 30 ct Box / ...)
      action: "created" | "restocked" | "failed"
      qtyQps: number                      // POOL units (QPs for flower, boxes for pre-roll)
      landedPerQp: number                 // landed cost per pool unit
      sellPrices?: Record<string, number> | null
      baseSku?: string                    // size-stripped SKU, set as QBO Item.Sku
      /* Input-unit fields drive QBO Item UoM: flower tracked in lb,
       * pre-rolls tracked in box. inputToPoolMultiplier=4 for flower
       * (4 QPs per lb) and 1 for pre-rolls. */
      inputToPoolMultiplier?: number
      inputUnitLabel?: string             // "lb" / "box"
      inputUnitSellPrice?: number         // per-lb sell price for flower; per-box for pre-rolls
      /** Medusa category hierarchy ["Flower", "Super"] / ["Pre-Rolls", "THC-A"]
       *  — used to find-or-create matching QBO Categories so the Item
       *  lands in the right Sales > Products & Services group. */
      categoryPath?: string[]
    }
    const lineResults = (record.line_results ?? []) as LineResult[]
    const usable = lineResults.filter((l) => l.action !== "failed" && l.qtyQps > 0 && l.landedPerQp > 0)
    if (usable.length === 0) {
      return res.status(400).json({ ok: false, error: "No successfully-saved lines on this receiving to push." })
    }

    const billLines = []
    for (const line of usable) {
      /* tierLabel from line_results is the right value for ANY profile
       * (flower / pre-roll / future). Fall back to LEGACY_TIER_LABEL
       * for pre-2026-05-14 receivings that didn't persist it. */
      const tierLabel =
        line.tierLabel
        ?? (line.tier && LEGACY_TIER_LABEL[line.tier])
        ?? line.tier
        ?? "Untiered"
      /* Primary item name: clean strain name. Fallback to suffixed
       * "Strain · Subcategory" only if QBO rejects with a duplicate-name
       * error (same strain already exists in a DIFFERENT category).
       * Category is set via ParentRef so the operator sees
       * "Flower:Rapper:Wedding Cake" instead of redundant
       * "Flower:Rapper:Wedding Cake · Rapper". */
      const primaryName = line.strainName
      const fallbackName = `${line.strainName} · ${tierLabel}`

      /* QBO Item is tracked in INPUT units (lb for flower, box for
       * pre-rolls). Convert pool-unit qty/rate → input-unit before
       * pushing. inputToPoolMultiplier=1 (pre-rolls + legacy receivings
       * without the field) is a no-op. */
      const multiplier = line.inputToPoolMultiplier && line.inputToPoolMultiplier > 0
        ? line.inputToPoolMultiplier
        : 1
      const inputUnit = line.inputUnitLabel ?? line.poolUnitLabel ?? "unit"
      const billQty = line.qtyQps / multiplier
      const billRate = line.landedPerQp * multiplier

      /* Item.UnitPrice default = per-input-unit sell price (LB price for
       * flower, per-box for pre-rolls). Falls back to first sellPrice
       * value when missing (legacy data). */
      const sellPriceForDefault =
        line.inputUnitSellPrice
        ?? (line.sellPrices ? Object.values(line.sellPrices)[0] : undefined)
        ?? undefined

      /* Resolve (or create) the QBO Category chain that mirrors Medusa.
       * Non-blocking: if resolving fails, the Item still creates — it
       * just lands at QBO root without a Category. */
      let parentCategoryId: string | undefined
      if (line.categoryPath && line.categoryPath.length > 0) {
        try {
          parentCategoryId = await resolveCategoryChain(qbo, conn, line.categoryPath)
        } catch (e: any) {
          logger.warn(`[qbo/push-bill] category resolve failed for ${line.strainName}: ${e?.message}`)
        }
      }

      const item = await findOrCreateItem(qbo, conn, primaryName, accounts, {
        fallbackName,
        sku: line.baseSku,
        purchaseCost: billRate,
        salePrice: sellPriceForDefault,
        preferredVendor: { id: vendor.id, name: vendor.displayName },
        purchaseDesc: `${line.strainName} · ${inputUnit} (landed cost)`,
        salesDesc: `${line.strainName} · per ${inputUnit}`,
        invStartDate: record.invoice_date.slice(0, 10),
        parentCategoryId,
      })
      billLines.push({
        itemId: item.id,
        itemName: item.name,
        qty: billQty,
        rate: billRate,
        /* Subcategory already appears in QBO's Item column (Category
         * prefix). Skipping the redundant `· {tierLabel}` here. */
        description: `${line.strainName} · per ${inputUnit} · landed cost (shipping capitalized)`,
      })
    }

    /* 6. Post the Bill. */
    const bill = await createBill(qbo, conn, {
      vendorId: vendor.id,
      invoiceNumber: record.invoice_number,
      invoiceDate: record.invoice_date.slice(0, 10),
      lines: billLines,
      privateNote: `MBS receiving #${record.id} — ${usable.length} strain(s)`,
    })

    /* 7. Persist back. */
    const nowIso = new Date().toISOString()
    await history.updateReceivingRecords({
      id: record.id,
      qbo_bill_id: bill.id,
      qbo_pushed_at: nowIso,
    })
    await qbo.updateQboConnections({
      id: conn.id,
      last_bill_id: bill.id,
      last_bill_pushed_at: nowIso,
    })

    const url = billPublicUrl(conn.environment, conn.realm_id, bill.id)
    logger.info(`[qbo/push-bill] pushed receiving ${record.id} → Bill ${bill.id} (${billLines.length} lines)`)
    return res.json({ ok: true, billId: bill.id, billUrl: url, lines: billLines.length })
  } catch (e: any) {
    logger.error(`[qbo/push-bill] failed for ${record.id}: ${e?.message}`)
    return res.status(500).json({ ok: false, error: e?.message ?? "QBO push failed" })
  }
}

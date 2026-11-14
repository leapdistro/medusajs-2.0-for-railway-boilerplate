import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  appendBillLines,
  billPublicUrl,
  createBill,
  findOrCreateItem,
  findOrCreateVendor,
  getActiveVendor,
  getDefaultAccounts,
  readEntity,
  resolveCategoryChain,
} from "../../../../lib/qbo-api"
import { QBO_CONNECTION_MODULE } from "../../../../modules/qbo-connection"
import { RECEIVING_HISTORY_MODULE } from "../../../../modules/receiving-history"
import { sendFeedNotification } from "../../../../lib/feed-notification"

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
  /** The Bill this line is on (stamped on push). */
  qboBillId?: string
}

/* Lines the Bill should carry: saved, with a quantity and a cost. */
const usableLines = (record: any) =>
  ((record.line_results ?? []) as LineResult[]).filter((l) => l.action !== "failed" && l.qtyQps > 0 && l.landedPerQp > 0)

/** Usable lines not on the record's Bill. Receivings pushed before lines
 *  were stamped count as fully billed (nothing to compare against). */
export function unbilledLines(record: any): LineResult[] {
  if (!record?.qbo_bill_id) return []
  const lines = usableLines(record)
  if (!lines.some((l) => l.qboBillId)) return []
  return lines.filter((l) => l.qboBillId !== String(record.qbo_bill_id))
}

/** Is this line already on the Bill? By stamp, else by the Bill's item
 *  names ("Flower:Classic:Wedding Cake", "… Ice Cream Cake · Classic"). */
function billedMatcher(record: any, bill: any) {
  const billId = String(record.qbo_bill_id)
  const names = new Set(((bill?.Line ?? []) as any[])
    .map((l) => String(l.ItemBasedExpenseLineDetail?.ItemRef?.name ?? "").split(":").pop()!.trim().toLowerCase())
    .filter(Boolean))
  return (l: LineResult) => {
    if (l.qboBillId) return l.qboBillId === billId
    const tier = (l.tierLabel ?? l.tier ?? "").toLowerCase()
    const branch = l.categoryPath && l.categoryPath.length >= 3 ? l.categoryPath[l.categoryPath.length - 2].toLowerCase() : ""
    const strain = l.strainName.trim().toLowerCase()
    return names.has(strain) || names.has(`${strain} · ${tier}`) || (!!branch && names.has(`${strain} · ${branch} ${tier}`))
  }
}

/** Stamp `qboBillId` on the lines now on the Bill. */
async function stampBilled(history: any, record: any, billId: string, onBill: LineResult[]) {
  const fresh = await history.retrieveReceivingRecord(record.id)
  const byKey = new Set(onBill.map((l) => `${l.strainName}|${l.tier ?? ""}`))
  const line_results = ((fresh?.line_results ?? record.line_results ?? []) as LineResult[]).map((l) =>
    byKey.has(`${l.strainName}|${l.tier ?? ""}`) ? { ...l, qboBillId: billId } : l)
  await history.updateReceivingRecords({ id: record.id, line_results })
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
 * with the existing id (and `unbilled`, the lines not on it yet).
 *
 * { historyId, append: true } adds the lines that aren't on the Bill yet
 * (saved later under the same invoice + supplier) to that Bill, dated as
 * it is. A line is on the Bill when it carries that `qboBillId` (stamped
 * on every push), or, for receivings pushed before the stamp existed,
 * when the Bill has an item with its name. `preview: true` with append
 * lists those lines and writes nothing.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)

  const body = (req.body ?? {}) as { historyId?: string; force?: boolean; append?: boolean; preview?: boolean }
  const historyId = body.historyId
  const force = body.force === true
  const append = body.append === true && !force
  if (!historyId) {
    return res.status(400).json({ ok: false, error: "historyId is required" })
  }

  /* 1. Load the receiving record. */
  const record = await history.retrieveReceivingRecord(historyId).catch(() => null)
  if (!record) {
    return res.status(404).json({ ok: false, error: `No receiving with id ${historyId}` })
  }
  if (record.qbo_bill_id && !force && !append) {
    return res.status(409).json({
      ok: false,
      error: "Already pushed to QuickBooks",
      billId: record.qbo_bill_id,
      pushedAt: record.qbo_pushed_at,
      unbilled: unbilledLines(record).length,
    })
  }
  if (append && !record.qbo_bill_id) {
    return res.status(400).json({ ok: false, error: "This receiving has no Bill yet: push it instead." })
  }
  if (record.qbo_bill_id && force) {
    /* Force re-push: previous Bill id/date get overwritten on success.
     * Use when the original QBO Bill was deleted (or partially cleaned
     * up) and the receiving needs to be re-posted so its Items + COGS
     * exist in QBO again. findOrCreateItem is idempotent per Name +
     * parent, so existing items are reused (no duplication); only
     * missing items get created. */
    logger.warn(
      `[qbo/push-bill] FORCE re-push requested for receiving ${record.id} (was Bill ${record.qbo_bill_id}, pushed ${record.qbo_pushed_at}) — will overwrite on success`,
    )
  }

  /* Failed pushes are stamped on the record (shown on the receiving's
   * history page) and ring the admin bell — the toast alone is easy to
   * miss and the Bill then never gets retried. */
  const recordFailure = async (message: string) => {
    logger.error(`[qbo/push-bill] failed for ${record.id}: ${message}`)
    await history.updateReceivingRecords({
      id: record.id,
      qbo_push_error: message.slice(0, 2000),
      qbo_push_error_at: new Date().toISOString(),
    }).catch((e: any) => logger.warn(`[qbo/push-bill] couldn't stamp push error: ${e?.message}`))
    await sendFeedNotification(req.scope, {
      title: `QBO Bill push failed for receiving ${record.invoice_number}`,
      description:
        `${message.slice(0, 200)}\n` +
        `Open: /app/receiving/history/${record.id} — fix the cause, then Push again.`,
    })
  }

  /* 2. Resolve the active QBO connection. */
  const connRows = await qbo.listQboConnections({}, { take: 1 })
  const conn = connRows[0]
  if (!conn) {
    return res.status(400).json({ ok: false, error: "QuickBooks is not connected. Visit /app/quickbooks → Connect first." })
  }

  /* 3. Vendor. */
  const supplier = (record.supplier ?? {}) as { name?: string; email?: string | null; phone?: string | null; address?: string | null; qboVendorId?: string | null }
  if (!supplier.name) {
    return res.status(400).json({ ok: false, error: "Receiving has no supplier.name — can't match vendor in QBO." })
  }

  /* 4. Pre-flight: default accounts (Inventory Asset, Income, COGS). */
  let accounts
  try {
    accounts = await getDefaultAccounts(qbo, conn)
  } catch (e: any) {
    await recordFailure(`Chart of accounts lookup failed: ${e?.message ?? "unknown error"}`)
    return res.status(500).json({ ok: false, error: e?.message ?? "QBO accounts lookup failed" })
  }

  try {
    /* Picked from the QBO vendor list at receiving: use that vendor.
     * Older receivings, or one whose vendor was since made inactive,
     * match by name as before. */
    const picked = supplier.qboVendorId ? await getActiveVendor(qbo, conn, supplier.qboVendorId) : null
    const vendor = picked
      ? { id: picked.id, displayName: picked.displayName, created: false }
      : await findOrCreateVendor(qbo, conn, {
        name: supplier.name,
        email: supplier.email ?? null,
        phone: supplier.phone ?? null,
        address: supplier.address ?? null,
      })

    /* 5. Lines: one per successfully-saved row. */
    const usable = usableLines(record)
    if (usable.length === 0) {
      return res.status(400).json({ ok: false, error: "No successfully-saved lines on this receiving to push." })
    }

    /* Latest Inventory Start Date among the Bill's items. QBO rejects a
     * Bill dated before any item's start date (6270) and won't move a
     * start date once the item has transactions — e.g. strains sold and
     * invoiced before their receiving's Bill was pushed. */
    const invoiceDate = record.invoice_date.slice(0, 10)
    let latestItemStart = invoiceDate
    const toBillLine = async (line: LineResult, startDate = invoiceDate) => {
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
      /* Third-level disambiguation for NEW cannabinoid branches (CBD,
       * CBG, THC-P) that share a strain name with legacy pre-split
       * items at Flower:<Tier>. `${strain} · Super` collides with the
       * old-tree item, so we escalate to `${strain} · CBD Super` etc.
       * The branch label comes from categoryPath (second-to-last
       * element in [Flower, CBD, Super]); empty for legacy 2-level
       * paths like [Flower, Super]. */
      const branchLabel = (line.categoryPath && line.categoryPath.length >= 3)
        ? line.categoryPath[line.categoryPath.length - 2]
        : ""
      const extraFallbackNames = (branchLabel && tierLabel)
        ? [`${line.strainName} · ${branchLabel} ${tierLabel}`]
        : []

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
        extraFallbackNames,
        sku: line.baseSku,
        purchaseCost: billRate,
        salePrice: sellPriceForDefault,
        preferredVendor: { id: vendor.id, name: vendor.displayName },
        purchaseDesc: `${line.strainName} · ${inputUnit} (landed cost)`,
        salesDesc: `${line.strainName} · per ${inputUnit}`,
        invStartDate: startDate,
        parentCategoryId,
      })
      return {
        invStartDate: item.invStartDate,
        billLine: {
          itemId: item.id,
          itemName: item.name,
          qty: billQty,
          rate: billRate,
          /* Subcategory already appears in QBO's Item column (Category
           * prefix). Skipping the redundant `· {tierLabel}` here. */
          description: `${line.strainName} · per ${inputUnit} · landed cost (shipping capitalized)`,
        },
      }
    }

    if (append) {
      const billId = String(record.qbo_bill_id)
      const current = await readEntity(qbo, conn, "Bill", billId)
      if (!current?.Id) throw new Error(`Bill ${billId} wasn't found in QuickBooks`)
      const onBill = billedMatcher(record, current)
      const toAdd = usable.filter((l) => !onBill(l))
      if (body.preview) {
        return res.json({
          ok: true, billId, billDate: current.TxnDate, billTotal: Number(current.TotalAmt) || 0,
          add: toAdd.map((l) => ({ strainName: l.strainName, tierLabel: l.tierLabel ?? l.tier, qty: l.qtyQps, unit: l.poolUnitLabel, landed: l.landedPerQp, amount: Math.round(l.qtyQps * l.landedPerQp * 100) / 100 })),
        })
      }
      if (toAdd.length === 0) {
        await stampBilled(history, record, billId, usable)
        return res.json({ ok: true, billId, added: 0, billUrl: billPublicUrl(conn.environment, conn.realm_id, billId) })
      }
      const billDate = String(current.TxnDate ?? invoiceDate).slice(0, 10)
      const added = []
      for (const line of toAdd) {
        const { billLine, invStartDate } = await toBillLine(line, billDate)
        if (invStartDate && invStartDate > billDate) {
          throw new Error(`${line.strainName}: its QuickBooks inventory start date (${invStartDate}) is after Bill ${billId}'s date (${billDate}), so it can't go on that Bill`)
        }
        added.push(billLine)
      }
      const updated = await appendBillLines(qbo, conn, billId, added,
        `${current.PrivateNote ? `${current.PrivateNote} · ` : ""}${added.length} more strain(s) added ${new Date().toISOString().slice(0, 10)} from the same receiving`)
      await stampBilled(history, record, billId, usable)
      await history.updateReceivingRecords({ id: record.id, qbo_push_error: null, qbo_push_error_at: null })
      logger.info(`[qbo/push-bill] receiving ${record.id}: added ${added.length} line(s) to Bill ${billId} (now $${updated.total})`)
      return res.json({ ok: true, billId, added: added.length, billTotal: updated.total, billUrl: billPublicUrl(conn.environment, conn.realm_id, billId) })
    }

    const billLines = []
    for (const line of usable) {
      const { billLine, invStartDate } = await toBillLine(line)
      if (invStartDate && invStartDate > latestItemStart) latestItemStart = invStartDate
      billLines.push(billLine)
    }

    /* 6. Post the Bill — dated at the supplier invoice date, or at the
     * latest item start date when that's later (memo keeps the original). */
    const billDate = latestItemStart
    const dateShifted = billDate !== invoiceDate
    if (dateShifted) {
      logger.warn(
        `[qbo/push-bill] receiving ${record.id}: Bill dated ${billDate} (supplier invoice ${invoiceDate}) — an item's QBO inventory start date is later`,
      )
    }
    const bill = await createBill(qbo, conn, {
      vendorId: vendor.id,
      invoiceNumber: record.invoice_number,
      invoiceDate: billDate,
      lines: billLines,
      privateNote: `MBS receiving #${record.id} — ${usable.length} strain(s)`
        + (dateShifted
          ? ` · Supplier invoice dated ${invoiceDate}; Bill dated ${billDate} because an item's inventory start date is ${billDate}.`
          : ""),
    })

    /* 7. Persist back. */
    const nowIso = new Date().toISOString()
    await stampBilled(history, record, bill.id, usable)
    await history.updateReceivingRecords({
      id: record.id,
      qbo_bill_id: bill.id,
      qbo_pushed_at: nowIso,
      qbo_push_error: null,
      qbo_push_error_at: null,
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
    await recordFailure(e?.message ?? "QBO push failed")
    return res.status(500).json({ ok: false, error: e?.message ?? "QBO push failed" })
  }
}

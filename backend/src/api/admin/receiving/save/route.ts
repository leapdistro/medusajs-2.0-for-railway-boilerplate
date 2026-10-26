import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  acquireInflightLock,
  getIdempotentResponse,
  releaseInflightLock,
  setIdempotentResponse,
} from "../../../../lib/idempotency"
import {
  buildSaveContext,
  checkRow,
  computeShipPerLb,
  previewRow,
  saveOneRow,
  type RowCheck,
  type SaveRow,
  type SaveRowResult,
  type ShippingRates,
  type TierKey,
  type TierPriceMap,
} from "../../../../lib/receiving-save"
import { findProfile } from "../../../../lib/profile-store"
import { MBS_SETTINGS_MODULE } from "../../../../modules/mbs-settings"
import { RECEIVING_HISTORY_MODULE } from "../../../../modules/receiving-history"
import { RECEIVING_DRAFTS_MODULE } from "../../../../modules/receiving-drafts"

/**
 * POST /admin/receiving/save
 *
 * Body shape (from the admin Receiving page on Save click):
 *   {
 *     supplier: { name, phone, email, address },
 *     invoiceNumber, invoiceDate,
 *     shippingTotal, total,
 *     rows: [SaveRow, ...],
 *     draftId?: string  // if resuming a draft, delete it on success
 *   }
 *
 * Behavior:
 *   1. Resolve tier prices from mbs-settings (`flower_tier_prices`)
 *   2. Build save context (categories, sales channel, location)
 *   3. Build the save context
 *   4. Skip rows this invoice + supplier already saved ("already-saved")
 *   5. Check every other row; if any fails, save NOTHING and return
 *      the failing rows (the rest come back "not-saved")
 *   6. Save rows; a row failing mid-write doesn't abort the rest
 *   7. Merge into the invoice's receiving_history record
 *   8. Delete the draft (if any) once every row is saved
 *
 * With `preview: true` it stops after step 5 and returns what each row
 * would do (would-create / would-restock, with stock, cost, attribute
 * and SKU details), writing nothing.
 *
 * Response:
 *   200 { ok, nothingSaved?, summary: { created, restocked, failed, alreadySaved }, results: [...], historyId, historyError?, error? }
 *   400 on body validation issues
 *   500 on context-build failure (categories missing, etc.)
 */

type Body = {
  supplier?: { name?: string; phone?: string | null; email?: string | null; address?: string | null }
  invoiceNumber?: string
  invoiceDate?: string
  shippingTotal?: number
  /* What the supplier billed (printed PDF). Used in QBO. */
  total?: number
  /* What the operator-reviewed rows actually sum to (Σ qty × cost +
   * shipping). Used for inventory accounting. May differ from `total`
   * if rows were edited / added / removed. */
  computedSubtotal?: number
  computedTotal?: number
  rows?: SaveRow[]
  draftId?: string | null
  /* Receiving profile — defaults to "flower" for backward compat with
   * the existing flower-only receiving page. Pre-roll receiving sends
   * "pre-roll" to switch the variant/category/pricing-model logic. */
  profileKey?: string
  /* Run every check and report what saving would do, writing nothing. */
  preview?: boolean
  /* The operator confirmed rows with no cost are free stock. Without
   * it, a row at $0 is refused: it would zero the cost basis, leave the
   * QBO bill empty and skip Owner prices (receiving 1112). */
  freeStock?: boolean
}

const IDEMPOTENCY_NS = "receiving-save"

const normName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase()
/* One line per strain per sub-category: the same strain can be
 * received into two tiers on one invoice. */
const lineKey = (strainName: unknown, tier: unknown) => `${normName(strainName)}|${String(tier ?? "")}`

/* Runs fn over items, 6 at a time. */
async function inPool<T>(items: T[], fn: (item: T) => Promise<void>, size = 6) {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) await fn(items[cursor++])
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

/* Replace res.json/status with a recording wrapper so we can cache
 * whatever the handler emitted under the idempotency key. The cached
 * payload replays exactly on a re-arrival of the same key. */
function makeRecordingRes(res: MedusaResponse) {
  let captured: { status: number; body: any } | null = null
  let statusCode = 200
  const origStatus = res.status.bind(res)
  const origJson = res.json.bind(res)
  ;(res as any).status = (code: number) => {
    statusCode = code
    return origStatus(code)
  }
  ;(res as any).json = (body: any) => {
    captured = { status: statusCode, body }
    return origJson(body)
  }
  return { getCaptured: () => captured }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const body = (req.body ?? {}) as Body

  /* Idempotency-Key: protects against double-clicks, network retries,
   * and multi-tab races. See lib/idempotency.ts. Header is optional
   * (legacy callers without a key still work); when present, we cache
   * the response for 24h and replay on duplicate arrivals.
   *
   * In-flight lock (60s) prevents simultaneous parallel execution if
   * two requests with the same key arrive before the first finishes;
   * the second waits for the lock to release, then reads the cache. */
  const preview = body.preview === true
  /* A preview writes nothing, so there's nothing to protect: a cached
   * preview would hide catalog changes since. */
  const idemKey = preview ? null : String(req.headers["idempotency-key"] ?? "").trim() || null
  if (idemKey) {
    const cached = await getIdempotentResponse(IDEMPOTENCY_NS, idemKey)
    if (cached) {
      res.setHeader("Idempotent-Replayed", "true")
      res.status(cached.status).json(cached.body)
      logger.info(`[receiving:save] replayed cached response for idempotency-key=${idemKey.slice(0, 8)}…`)
      return
    }
    const gotLock = await acquireInflightLock(IDEMPOTENCY_NS, idemKey)
    if (!gotLock) {
      /* Another request with the same key is in flight. Tell the client
       * to retry the GET-the-cached-result by re-sending the same key
       * shortly. 409 is the closest semantic match. */
      res.status(409).json({ ok: false, error: "Receiving save already in progress for this idempotency key. Retry shortly." })
      return
    }
  }

  /* Wire the recording wrapper so we can stash the response after the
   * handler runs (only when idempotency is in play — avoid the
   * allocation otherwise). */
  const rec = idemKey ? makeRecordingRes(res) : null

  try {

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ ok: false, error: "rows[] is required" })
    return
  }
  if (!body.invoiceNumber || !body.invoiceDate) {
    res.status(400).json({ ok: false, error: "invoiceNumber and invoiceDate are required" })
    return
  }

  if (!preview && body.freeStock !== true) {
    const noCost = body.rows.filter((r) => !(Number(r.unitPrice) > 0))
    if (noCost.length > 0) {
      res.status(400).json({
        ok: false,
        error: `No cost on ${noCost.map((r) => r.strainName || "(unnamed)").join(", ")}. Enter the cost, or confirm it's free stock.`,
      })
      return
    }
  }

  /* 1. Resolve the receiving profile (default "flower" for backward compat). */
  const profileKey = String(body.profileKey ?? "flower")
  const profile = await findProfile(req.scope, profileKey)
  if (!profile) {
    res.status(400).json({ ok: false, error: `Unknown receiving profile: ${profileKey}` })
    return
  }
  if (profile.archived) {
    res.status(400).json({ ok: false, error: `${profile.displayName} is archived in MBS Settings → Categories; un-archive it to receive.` })
    return
  }

  /* 2. Tier prices (only relevant when profile.pricingModel === "tier").
   *    For "flat" pricing, rows carry their own sellPrice and tierPrices
   *    is unused — pass an empty map. The setting key comes FROM the
   *    profile so flower reads flower_tier_prices and pre-roll reads
   *    pre_roll_tier_prices without a hardcoded branch here. */
  const settings: any = req.scope.resolve(MBS_SETTINGS_MODULE)
  let tierPrices: TierPriceMap | null = null
  if (profile.pricingModel === "tier") {
    const settingKey = profile.tierPricesSettingKey
    if (!settingKey) {
      res.status(500).json({
        ok: false,
        error: `Profile "${profile.key}" uses pricingModel "tier" but has no tierPricesSettingKey configured.`,
      })
      return
    }
    tierPrices = (await settings.getSetting(settingKey)) as TierPriceMap | null
    if (!tierPrices) {
      res.status(500).json({
        ok: false,
        error: `${settingKey} not configured. Run \`pnpm seed:settings\` or set ${profile.displayName} prices in MBS Settings.`,
      })
      return
    }
  }

  /* 2b. Shipping rates — soft-required. If missing, new variants
   *     just skip the variant.weight stamp; operator can fill via
   *     MBS Settings → Shipping Rates → Apply later. */
  const shippingRates = (await settings.getSetting("shipping_rates")) as ShippingRates | null

  /* 3. Build save context (resolves categories/channel/location once). */
  const shipPerLb = computeShipPerLb(body.rows, body.shippingTotal ?? 0)
  let ctx
  try {
    ctx = await buildSaveContext(req.scope, shipPerLb, tierPrices ?? ({} as TierPriceMap), shippingRates, profile)
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Save context failed" })
    return
  }

  const rows = body.rows
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)

  /* 4. Rows this invoice already saved. Saving again after a partial
   *    failure re-sends every row; without this the rows that worked
   *    the first time would be restocked a second time. A row counts as
   *    saved when this invoice's record (same number AND supplier, since
   *    two suppliers can both use "1001") has it as created or
   *    restocked. If the lookup itself fails, nothing is saved: guessing
   *    "not saved" is what doubles stock. */
  let existingRecord: any = null
  try {
    const sameNumber = await history.listReceivingRecords(
      { invoice_number: [body.invoiceNumber] },
      { take: 50, order: { created_at: "DESC" } },
    )
    const supplierKey = normName(body.supplier?.name)
    existingRecord = (sameNumber as any[]).find((r) => normName(r.supplier?.name) === supplierKey) ?? null
  } catch (e: any) {
    logger.error(`[receiving:save] history lookup failed: ${e?.message}`)
    res.status(500).json({ ok: false, error: `Couldn't check what invoice ${body.invoiceNumber} already saved, so nothing was saved: ${e?.message ?? e}` })
    return
  }
  const savedKeys = new Set(
    ((existingRecord?.line_results ?? []) as any[])
      .filter((l) => l.action === "created" || l.action === "restocked")
      .map((l) => lineKey(l.strainName, l.tier)),
  )

  const results: SaveRowResult[] = new Array(rows.length)
  const toSave: number[] = []
  rows.forEach((row, i) => {
    if (savedKeys.has(lineKey(row.strainName, row.tier))) {
      results[i] = {
        strainName: row.strainName,
        tier: row.tier,
        action: "already-saved",
        qtyQps: 0,
        landedPerQp: 0,
        sellPrices: null,
      }
    } else {
      toSave.push(i)
    }
  })

  /* 5. Check every row before writing anything (read-only), so a bad
   *    row stops the receiving with nothing changed instead of leaving
   *    half of it in stock. Rows are checked again as they save, in
   *    case the catalog changed in between. */
  const checks = new Map<number, RowCheck>()
  await inPool(toSave, async (i) => {
    checks.set(i, await checkRow(req.scope, rows[i], ctx))
  })
  const errors = new Map<number, string>()
  for (const i of toSave) {
    const err = checks.get(i)?.error
    if (err) errors.set(i, err)
  }
  /* Problems only visible across rows: the same strain twice, or two
   * strains that would get the same SKU or restock the same product.
   * Saved side by side, the second would fail or its stock would be
   * lost. */
  const flagShared = (keyOf: (i: number) => string | null, message: (others: string) => string) => {
    const groups = new Map<string, number[]>()
    for (const i of toSave) {
      const k = keyOf(i)
      if (k) groups.set(k, [...(groups.get(k) ?? []), i])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (const i of group) {
        if (errors.has(i)) continue
        const others = group.filter((j) => j !== i).map((j) => `row ${j + 1}`).join(", ")
        errors.set(i, message(others))
      }
    }
  }
  flagShared(
    (i) => lineKey(rows[i].strainName, rows[i].tier),
    (others) => `Same strain and sub-category as ${others}. Combine them into one row.`,
  )
  flagShared(
    (i) => {
      const plan = checks.get(i)?.plan
      return plan?.kind === "create" ? `sku:${plan.baseSku}` : plan?.kind === "restock" ? `product:${plan.productId}` : null
    },
    (others) => `Would save to the same product or SKU as ${others}. Rename one of the strains.`,
  )

  if (errors.size > 0) {
    for (const i of toSave) {
      const base = checks.get(i)!.base
      results[i] = errors.has(i)
        ? { ...base, action: "failed", error: errors.get(i) }
        : { ...base, action: "not-saved" }
    }
    if (!preview) logger.warn(`[receiving:save] invoice ${body.invoiceNumber}: ${errors.size} row(s) failed the check, nothing saved`)
    res.json({
      ok: false,
      ...(preview ? { preview: true } : {}),
      nothingSaved: true,
      summary: { created: 0, restocked: 0, failed: errors.size, alreadySaved: rows.length - toSave.length },
      results,
      historyId: existingRecord?.id,
      error: errors.size === 1 ? Array.from(errors.values())[0] : undefined,
    })
    return
  }

  if (preview) {
    await inPool(toSave, async (i) => {
      const check = checks.get(i)!
      const plan = check.plan!
      try {
        results[i] = {
          ...check.base,
          ...(plan.kind === "restock"
            ? { action: "would-restock", productId: plan.productId, productHandle: plan.productHandle, inventoryItemId: plan.inventoryItemId }
            : { action: "would-create", productHandle: plan.createHandle }),
          baseSku: plan.baseSku,
          preview: await previewRow(req.scope, rows[i], check, ctx),
        }
      } catch (e: any) {
        results[i] = { ...check.base, action: "failed", error: `Preview failed: ${e?.message ?? e}` }
      }
    })
    const failed = results.filter((r) => r.action === "failed").length
    res.json({
      ok: failed === 0,
      preview: true,
      summary: {
        create: results.filter((r) => r.action === "would-create").length,
        restock: results.filter((r) => r.action === "would-restock").length,
        failed,
        alreadySaved: rows.length - toSave.length,
      },
      results,
      historyId: existingRecord?.id,
    })
    return
  }

  /* 6. Save, 6 rows at a time. Each row creates a separate strain
   *    (different inventory item, different product handle), and the
   *    cross-row check above guarantees that, so they're independent.
   *    Serial was burning ~8s/row × 29 = 4 min, which blew past the
   *    browser's HTTP timeout (60-120s) and silently orphaned
   *    products. 6 at a time brings 29 rows to ~30-40s. */
  await inPool(toSave, async (i) => {
    const result = await saveOneRow(req.scope, rows[i], ctx)
    results[i] = result
    if (result.action === "failed") {
      logger.warn(`[receiving:save] ${rows[i].strainName}: ${result.error}`)
    }
  })

  const summary = {
    created: results.filter((r) => r.action === "created").length,
    restocked: results.filter((r) => r.action === "restocked").length,
    failed: results.filter((r) => r.action === "failed").length,
    alreadySaved: rows.length - toSave.length,
  }

  /* 7. Audit trail: one record per invoice + supplier. Saving again
   *    merges into it, by strain + sub-category: this attempt's rows
   *    win, earlier rows not in it are kept, and skipped rows keep
   *    their earlier entry. */
  let historyId: string | undefined = existingRecord?.id
  let historyError: string | undefined
  const attempted = toSave.map((i) => results[i])
  if (attempted.length > 0) {
    try {
      const byLine = new Map<string, any>()
      for (const r of (existingRecord?.line_results ?? []) as any[]) byLine.set(lineKey(r.strainName, r.tier), r)
      for (const r of attempted) byLine.set(lineKey(r.strainName, r.tier), r)
      const lineResults = Array.from(byLine.values())

      const recordPayload = {
        invoice_number: body.invoiceNumber,
        invoice_date: body.invoiceDate,
        supplier: body.supplier ?? {},
        shipping_total: String((body.shippingTotal ?? 0).toFixed(2)),
        invoice_total: String((body.total ?? 0).toFixed(2)),
        total_qps: lineResults.reduce((s, r: any) => s + (r.qtyQps || 0), 0),
        line_results: lineResults,
        notes: null,
      }
      if (existingRecord) {
        logger.info(`[receiving:save] updating EXISTING history record ${existingRecord.id} (${lineResults.length} line_results, ${attempted.length} from this save)…`)
        await history.updateReceivingRecords([{ id: existingRecord.id, ...recordPayload }])
        logger.info(`[receiving:save] ✓ history record ${historyId} merged`)
      } else {
        logger.info(`[receiving:save] writing NEW history record (${lineResults.length} line_results)…`)
        const [record] = await history.createReceivingRecords([recordPayload])
        historyId = record.id
        logger.info(`[receiving:save] ✓ history record ${historyId}`)
      }
    } catch (e: any) {
      /* Surface FULL error including stack to terminal AND propagate to
       * response body so the operator sees it in the toast / browser
       * console. Silently swallowing here is what hid the bug for hours. */
      historyError = e?.message ?? String(e)
      logger.error(`[receiving:save] ✗ HISTORY WRITE FAILED: ${historyError}`)
      if (e?.stack) logger.error(e.stack)
    }
  }

  /* 7b. Emit receiving.saved whenever a row was written, so the
   *     Owner Stores and customer-group price subscribers cover the
   *     rows that saved even when another row failed. Receiving updates
   *     inventory_item.metadata.landed_per_qp, which is the cost basis
   *     for Owner Stores PriceList rows, and new strains need their
   *     group prices. */
  if (summary.created + summary.restocked > 0 && historyId) {
    try {
      const eventBus: any = req.scope.resolve(Modules.EVENT_BUS)
      await eventBus.emit({
        name: "receiving.saved",
        data: {
          history_id: historyId,
          profile_key: profile.key,
          summary,
        },
      })
    } catch (e: any) {
      logger.warn(`[receiving:save] event emit failed: ${e?.message}`)
    }
  }

  /* 8. Discard the draft if every row is now saved. Otherwise keep it
   *    so the operator can fix + retry (saved rows are skipped). */
  if (body.draftId && summary.failed === 0) {
    try {
      const drafts: any = req.scope.resolve(RECEIVING_DRAFTS_MODULE)
      await drafts.deleteReceivingDrafts([body.draftId])
    } catch (e: any) {
      logger.warn(`[receiving:save] draft delete failed (${body.draftId}): ${e?.message}`)
    }
  }

  res.json({
    ok: summary.failed === 0,
    summary,
    results,
    historyId,
    historyError,                          // surface so the toast / DevTools sees it
    /* Convenience: a single error string when there's exactly one failure. */
    error: summary.failed === 1
      ? results.find((r) => r.action === "failed")?.error
      : undefined,
  })

  } finally {
    /* Cache the response under the idempotency key so a duplicate
     * arrival replays the same bytes. Lock release ensures any
     * sibling request can proceed (it'll hit the cache). */
    if (idemKey) {
      const captured = rec?.getCaptured()
      if (captured) {
        await setIdempotentResponse(IDEMPOTENCY_NS, idemKey, captured.status, captured.body)
      }
      await releaseInflightLock(IDEMPOTENCY_NS, idemKey)
    }
  }
}

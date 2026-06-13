import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  buildSaveContext,
  computeShipPerLb,
  saveOneRow,
  type SaveRow,
  type ShippingRates,
  type TierKey,
  type TierPriceMap,
} from "../../../../lib/receiving-save"
import { getProfile, type ProfileKey } from "../../../../lib/receiving-profiles"
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
 *   3. Loop rows; each is best-effort — failures don't abort the rest
 *   4. Write a receiving_history record summarizing what happened
 *   5. Delete the draft (if any) on full or partial success
 *   6. Respond with per-row outcomes for the admin to render
 *
 * Response:
 *   200 { ok: true, summary: { created, restocked, failed }, results: [...], historyId, errors: [...] }
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
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const body = (req.body ?? {}) as Body

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ ok: false, error: "rows[] is required" })
    return
  }
  if (!body.invoiceNumber || !body.invoiceDate) {
    res.status(400).json({ ok: false, error: "invoiceNumber and invoiceDate are required" })
    return
  }

  /* 1. Resolve the receiving profile (default "flower" for backward compat). */
  const profileKey = (body.profileKey ?? "flower") as ProfileKey
  let profile
  try {
    profile = getProfile(profileKey)
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message ?? "Unknown profile" })
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
        error: `${settingKey} not configured. Run \`pnpm seed:settings\` or set them in MBS Settings → ${settingKey === "flower_tier_prices" ? "Flower" : "Pre-Roll"} Tier Prices.`,
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

  /* 3. Process rows with bounded concurrency. Each row creates a
   *    separate strain (different inventory item, different product
   *    handle), so they're independent — no race risk inside one
   *    receiving. Serial was burning ~8s/row × 29 = 4 min, which
   *    blew past the browser's HTTP timeout (60-120s) and silently
   *    orphaned products. CONCURRENCY=6 brings 29 rows to ~30-40s. */
  const CONCURRENCY = 6
  const results: Awaited<ReturnType<typeof saveOneRow>>[] = new Array(body.rows.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < body.rows!.length) {
      const myIdx = cursor++
      const row = body.rows![myIdx]
      const result = await saveOneRow(req.scope, row, ctx)
      results[myIdx] = result
      if (result.action === "failed") {
        logger.warn(`[receiving:save] ${row.strainName}: ${result.error}`)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, body.rows.length) }, worker),
  )

  const summary = {
    created: results.filter((r) => r.action === "created").length,
    restocked: results.filter((r) => r.action === "restocked").length,
    failed: results.filter((r) => r.action === "failed").length,
  }

  /* 4. Audit trail. Always write — even if everything failed,
   *    operators want to see what was attempted.
   *
   *    Idempotent by invoice_number: each invoice should have ONE
   *    receiving_record. On retry (same invoice number), we update
   *    the existing row's line_results instead of inserting a new
   *    one. Latest-wins is correct — earlier attempts are noise.
   *    Audit before this change shipped: 8 rows for one invoice. */
  const history: any = req.scope.resolve(RECEIVING_HISTORY_MODULE)
  let historyId: string | undefined
  let historyError: string | undefined
  try {
    const totalQps = results.reduce((s, r) => s + (r.qtyQps || 0), 0)
    const existing = body.invoiceNumber
      ? await history.listReceivingRecords({ invoice_number: [body.invoiceNumber] }, { take: 1 }).catch(() => [])
      : []

    /* Merge line_results by strain name when updating an existing
     * record — latest attempt per strain wins, but prior successes
     * for strains NOT in this batch are preserved. Stops a 2-strain
     * retry of a 30-strain invoice from wiping the 28 prior successes
     * out of the audit trail.
     *
     * Reasonable invariant: each invoice has one row per strain.
     * Duplicates within an invoice are a data-entry mistake; we keep
     * the latest version regardless. */
    let mergedLineResults = results
    let mergedTotalQps = totalQps
    if (existing?.length > 0) {
      const prior = (existing[0].line_results ?? []) as Array<{ strainName: string;[k: string]: any }>
      const byStrain = new Map<string, any>()
      for (const r of prior) byStrain.set(String(r.strainName ?? ""), r)
      for (const r of results) byStrain.set(String(r.strainName ?? ""), r)
      mergedLineResults = Array.from(byStrain.values()) as typeof results
      mergedTotalQps = mergedLineResults.reduce((s, r: any) => s + (r.qtyQps || 0), 0)
    }

    const recordPayload = {
      invoice_number: body.invoiceNumber,
      invoice_date: body.invoiceDate,
      supplier: body.supplier ?? {},
      shipping_total: String((body.shippingTotal ?? 0).toFixed(2)),
      invoice_total: String((body.total ?? 0).toFixed(2)),
      total_qps: mergedTotalQps,
      line_results: mergedLineResults,
      notes: null,
    }
    if (existing?.length > 0) {
      logger.info(`[receiving:save] updating EXISTING history record ${existing[0].id} (merged ${mergedLineResults.length} line_results — ${results.length} new + prior preserved)…`)
      await history.updateReceivingRecords([{ id: existing[0].id, ...recordPayload }])
      historyId = existing[0].id
      logger.info(`[receiving:save] ✓ history record ${historyId} merged`)
    } else {
      logger.info(`[receiving:save] writing NEW history record (${results.length} line_results)…`)
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

  /* 4b. Emit receiving.saved on full success so the owner-stores
   *     price subscriber can refresh prices for the touched profile.
   *     Receiving updates inventory_item.metadata.landed_per_qp, which
   *     is the cost basis for Owner Stores PriceList rows. */
  if (summary.failed === 0 && historyId) {
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

  /* 5. Discard the draft if all rows succeeded. Partial success keeps
   *    the draft so the operator can fix + retry. */
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
}

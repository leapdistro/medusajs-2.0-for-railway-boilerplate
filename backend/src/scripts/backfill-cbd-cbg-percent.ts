import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_ATTRIBUTES_MODULE } from "../modules/mbs-attributes"
import { extractCoa } from "../lib/ai-coa-extraction"

/**
 * One-off — re-extract CBD/CBG % from every hemp-flower COA.
 *
 * Why: the receiving flow historically called the AI extractor with no
 * primary hint, which defaults to "prefer THCa". On hemp CBD/CBG COAs,
 * THCa is a trace value (<0.3%) — that got stamped into cbd_percent /
 * cbg_percent and rendered on the storefront as "0.184% CBD" instead
 * of the real ~18% CBD number.
 *
 * This script:
 *   1. Finds every product in a CBD/CBG category (handle starts with
 *      cbd-, cbg-, flower-cbd, or flower-cbg).
 *   2. Filters to products where the branch's percent field is
 *      suspicious (< 3%) AND a coa_url is present.
 *   3. Re-runs extractCoa with the correct primary ("CBD" or "CBG").
 *   4. Writes the returned value back to product_attributes.
 *
 * Dry-run by default. APPLY=1 to write.
 *
 * Usage:
 *   pnpm exec medusa exec ./src/scripts/backfill-cbd-cbg-percent.ts
 *   APPLY=1 pnpm exec medusa exec ./src/scripts/backfill-cbd-cbg-percent.ts
 */

const SUSPICION_THRESHOLD = 3 /* % — any value below this on a CBD/CBG
                                   * product is almost certainly the trace
                                   * THCa the old extractor grabbed. */

function isCbdCategory(handle: string | null | undefined): boolean {
  const h = (handle ?? "").toLowerCase()
  return h.startsWith("cbd-") || h === "flower-cbd" || h.startsWith("flower-cbd-")
}
function isCbgCategory(handle: string | null | undefined): boolean {
  const h = (handle ?? "").toLowerCase()
  return h.startsWith("cbg-") || h === "flower-cbg" || h.startsWith("flower-cbg-")
}

export default async function backfillCbdCbgPercent({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const mbsAttrs: any = container.resolve(MBS_ATTRIBUTES_MODULE)
  const apply = process.env.APPLY === "1"

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "handle",
      "title",
      "categories.handle",
      "product_attributes.id",
      "product_attributes.cbd_percent",
      "product_attributes.cbg_percent",
      "product_attributes.coa_url",
    ],
    filters: { deleted_at: null },
  })

  type Candidate = {
    productId: string
    handle: string
    title: string
    attrsId: string
    coaUrl: string
    branch: "CBD" | "CBG"
    currentPct: number | null
  }
  const candidates: Candidate[] = []
  let skippedNotHemp = 0
  let skippedNoCoa = 0
  let skippedNoAttrs = 0
  let skippedAlreadyPlausible = 0

  for (const p of (products as any[]) ?? []) {
    const cats: any[] = p.categories ?? []
    const isCbd = cats.some((c) => isCbdCategory(c?.handle))
    const isCbg = cats.some((c) => isCbgCategory(c?.handle))
    if (!isCbd && !isCbg) {
      skippedNotHemp += 1
      continue
    }
    const attrs = p.product_attributes as any
    if (!attrs?.id) {
      skippedNoAttrs += 1
      continue
    }
    if (!attrs.coa_url) {
      skippedNoCoa += 1
      continue
    }
    const branch: "CBD" | "CBG" = isCbg ? "CBG" : "CBD"
    const rawCurrent = branch === "CBG" ? attrs.cbg_percent : attrs.cbd_percent
    const currentPct = rawCurrent == null ? null : Number(rawCurrent)
    if (currentPct != null && Number.isFinite(currentPct) && currentPct >= SUSPICION_THRESHOLD) {
      skippedAlreadyPlausible += 1
      continue
    }
    candidates.push({
      productId: p.id,
      handle: p.handle,
      title: p.title,
      attrsId: attrs.id,
      coaUrl: attrs.coa_url,
      branch,
      currentPct,
    })
  }

  logger.info("─────────────────────────────────────────────")
  logger.info("BACKFILL: CBD/CBG percent from COA")
  logger.info(`  Products total:              ${(products as any[])?.length ?? 0}`)
  logger.info(`  Skipped (not CBD/CBG):       ${skippedNotHemp}`)
  logger.info(`  Skipped (no product_attrs):  ${skippedNoAttrs}`)
  logger.info(`  Skipped (no coa_url):        ${skippedNoCoa}`)
  logger.info(`  Skipped (already ≥ ${SUSPICION_THRESHOLD}%):    ${skippedAlreadyPlausible}`)
  logger.info(`  Candidates to re-extract:    ${candidates.length}`)
  logger.info("─────────────────────────────────────────────")

  if (candidates.length === 0) {
    logger.info("Nothing to backfill.")
    return
  }

  if (!apply) {
    logger.info("DRY RUN — showing first 20 candidates. Re-run with APPLY=1 to actually re-extract + write.")
    for (const c of candidates.slice(0, 20)) {
      const cur = c.currentPct == null ? "null" : `${c.currentPct}%`
      logger.info(`  · [${c.branch}] ${c.handle.padEnd(36)} current=${cur.padEnd(8)}  coa=${c.coaUrl}`)
    }
    if (candidates.length > 20) logger.info(`  · …and ${candidates.length - 20} more`)
    return
  }

  logger.warn(`▶ APPLY=1 — re-extracting ${candidates.length} COA(s) in 3s. Est. cost ≈ $${(candidates.length * 0.015).toFixed(2)}.`)
  await new Promise((r) => setTimeout(r, 3000))

  let ok = 0, unchanged = 0, extractFailed = 0, writeFailed = 0
  let totalIn = 0, totalOut = 0
  for (const c of candidates) {
    let pdfBytes: Buffer
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      const fetchRes = await fetch(c.coaUrl, { signal: controller.signal })
      clearTimeout(timer)
      if (!fetchRes.ok) {
        logger.warn(`  ! ${c.handle}: fetch ${c.coaUrl} → ${fetchRes.status}`)
        extractFailed += 1
        continue
      }
      pdfBytes = Buffer.from(await fetchRes.arrayBuffer())
    } catch (e: any) {
      logger.warn(`  ! ${c.handle}: fetch error ${e?.message ?? String(e)}`)
      extractFailed += 1
      continue
    }

    const result = await extractCoa(pdfBytes, c.branch)
    totalIn += result.inputTokens
    totalOut += result.outputTokens
    if (!result.ok || result.data == null) {
      logger.warn(`  ! ${c.handle}: extractor error ${result.error ?? "unknown"}`)
      extractFailed += 1
      continue
    }
    const newPct = result.data.thcaPercent /* schema-name: holds primary cannabinoid */
    if (newPct == null) {
      logger.warn(`  ! ${c.handle}: extractor returned null (no ${c.branch} row on COA?)`)
      extractFailed += 1
      continue
    }
    if (c.currentPct != null && Number(newPct) === Number(c.currentPct)) {
      unchanged += 1
      continue
    }
    try {
      const payload: any = { id: c.attrsId }
      if (c.branch === "CBG") payload.cbg_percent = String(newPct)
      else payload.cbd_percent = String(newPct)
      await mbsAttrs.updateProductAttributes(payload)
      logger.info(`  ✓ ${c.handle.padEnd(36)} [${c.branch}] ${c.currentPct ?? "null"} → ${newPct}%`)
      ok += 1
    } catch (e: any) {
      logger.warn(`  ! ${c.handle}: write failed ${e?.message ?? String(e)}`)
      writeFailed += 1
    }
  }

  logger.info("─────────────────────────────────────────────")
  logger.info(`✓ Updated:          ${ok}`)
  logger.info(`  Unchanged:        ${unchanged}`)
  logger.info(`  Extract failed:   ${extractFailed}`)
  logger.info(`  Write failed:     ${writeFailed}`)
  logger.info(`  Tokens in/out:    ${totalIn} / ${totalOut}`)
  logger.info("─────────────────────────────────────────────")
}

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_ATTRIBUTES_MODULE } from "../modules/mbs-attributes"
import { extractCoa, PrimaryCannabinoid } from "../lib/ai-coa-extraction"

/**
 * Repairs CBD / CBG products whose primary-cannabinoid % holds the COA's
 * THCa number instead of its CBD / CBG number.
 *
 * Cause: until 2026-09 the receiving page's COA auto-fill called
 * /admin/receiving/coa-parse without a `primary`, so the extractor ran its
 * THCa-first prompt. A hemp COA lists THCa (the <0.3% compliance figure)
 * right beside the CBD line, so the THCa value came back and the receiving
 * spreadsheet dropped it into the "CBD %" column → `cbd_percent`. The
 * storefront reads that column for CBD products, so the wrong number
 * reached the PDP, the product tiles and the printed labels.
 *
 * This re-parses each affected product's stored COA with the branch-correct
 * prompt and rewrites `cbd_percent` / `cbg_percent`. Products with no COA on
 * file are reported, not guessed at — an operator fixes those by hand in the
 * MBS Attributes widget.
 *
 * Dry-run by default: prints old → new for every product and writes nothing.
 * Re-run with APPLY=1 once the diff looks right.
 *
 * Usage:
 *   pnpm fix:cbd-cbg-percent                      (dry run, every CBD+CBG product)
 *   APPLY=1 pnpm fix:cbd-cbg-percent              (write the corrections)
 *   HANDLES=blue-dream,sour-space pnpm fix:...    (scope to specific products)
 *   LIMIT=5 pnpm fix:cbd-cbg-percent              (cost control — ~$0.011/COA)
 */

type Branch = { key: "cbd" | "cbg"; field: "cbd_percent" | "cbg_percent"; primary: PrimaryCannabinoid }

const BRANCHES: Branch[] = [
  { key: "cbd", field: "cbd_percent", primary: "CBD" },
  { key: "cbg", field: "cbg_percent", primary: "CBG" },
]

/* Same detection the storefront adapter and the MBS Attributes widget use:
 * CBD products carry `flower-cbd` or a `cbd-<tier>` sub-category handle. */
function branchFor(cats: Array<{ name?: string; handle?: string }>): Branch | null {
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase()
  for (const c of cats) {
    const handle = norm(c.handle)
    const name = norm(c.name)
    for (const b of BRANCHES) {
      if (
        handle === `flower-${b.key}` ||
        handle.startsWith(`flower-${b.key}-`) ||
        handle.startsWith(`${b.key}-`) ||
        name === b.key
      ) {
        return b
      }
    }
  }
  return null
}

async function fetchCoa(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 15 * 1024 * 1024) throw new Error("COA file too large (>15 MB)")
    return Buffer.from(buf)
  } finally {
    clearTimeout(timer)
  }
}

export default async function fixCbdCbgPercent({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const mbsAttrs: any = container.resolve(MBS_ATTRIBUTES_MODULE)

  const apply = process.env.APPLY === "1"
  const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity
  const handleFilter = (process.env.HANDLES ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", "handle", "title",
      "categories.name", "categories.handle",
      "product_attributes.id",
      "product_attributes.thca_percent",
      "product_attributes.cbd_percent",
      "product_attributes.cbg_percent",
      "product_attributes.coa_url",
    ],
    filters: handleFilter.length ? { handle: handleFilter } : {},
  })

  const targets = (products ?? [])
    .map((p: any) => ({ p, branch: branchFor(p.categories ?? []) }))
    .filter((t): t is { p: any; branch: Branch } => t.branch !== null)
    .slice(0, limit)

  if (targets.length === 0) {
    logger.info("No CBD / CBG products matched — nothing to repair.")
    return
  }

  logger.info(
    `▶ ${targets.length} CBD/CBG product(s) to check · ${apply ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`,
  )

  let corrected = 0
  let unchanged = 0
  let skipped = 0
  let failed = 0
  let tokensIn = 0
  let tokensOut = 0

  for (const { p, branch } of targets) {
    const attrs = p.product_attributes
    const label = `${p.handle ?? p.id}`.padEnd(32)
    const coaUrl: string | null = attrs?.coa_url ?? null

    if (!attrs?.id) {
      logger.warn(`  · ${label} SKIP — no MBS attributes row`)
      skipped += 1
      continue
    }
    if (!coaUrl) {
      logger.warn(`  · ${label} SKIP — no COA on file; fix by hand in MBS Attributes`)
      skipped += 1
      continue
    }

    const before = attrs[branch.field] != null ? String(attrs[branch.field]) : null

    let pdfBytes: Buffer
    try {
      pdfBytes = await fetchCoa(coaUrl)
    } catch (e: any) {
      logger.error(`  ✗ ${label} FETCH FAILED: ${e?.message ?? String(e)}`)
      failed += 1
      continue
    }

    const result = await extractCoa(pdfBytes, branch.primary)
    tokensIn += result.inputTokens
    tokensOut += result.outputTokens

    if (!result.ok || result.data?.thcaPercent == null) {
      logger.error(
        `  ✗ ${label} EXTRACT FAILED: ${result.error ?? `no ${branch.primary} value found on the COA`}`,
      )
      failed += 1
      continue
    }

    const after = String(result.data.thcaPercent)
    if (before === after) {
      logger.info(`  = ${label} ${branch.primary} ${after}% already correct`)
      unchanged += 1
      continue
    }

    const note = result.data.notes ? ` · AI note: ${result.data.notes}` : ""
    logger.info(`  → ${label} ${branch.primary} ${before ?? "(empty)"}% → ${after}%${note}`)

    if (apply) {
      try {
        await mbsAttrs.updateProductAttributes({ id: attrs.id, [branch.field]: after })
        corrected += 1
      } catch (e: any) {
        logger.error(`  ✗ ${label} WRITE FAILED: ${e?.message ?? String(e)}`)
        failed += 1
      }
    } else {
      corrected += 1
    }
  }

  /* Sonnet pricing at the time of writing: $3/M in, $15/M out. */
  const cost = (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15
  logger.info(
    `▲ ${apply ? "corrected" : "would correct"} ${corrected} · ${unchanged} already correct · ` +
    `${skipped} skipped · ${failed} failed · ~$${cost.toFixed(3)}`,
  )
  if (!apply && corrected > 0) {
    logger.info("  Re-run with APPLY=1 to write these corrections.")
  }
}

import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { promises as fs } from "fs"
import path from "path"
import { extractCoa } from "../lib/ai-coa-extraction"

/**
 * Batch-test the COA extractor against a folder of COA PDFs. Prints a
 * one-line summary per file (THCa% / Cann% / notes / cost).
 *
 * Usage:
 *   COA_DIR=/path/to/folder pnpm test:coa-extract
 *   COA_DIR=... LIMIT=3 pnpm test:coa-extract   (only first N for cost control)
 */
export default async function testCoaExtract({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const dir = process.env.COA_DIR
  if (!dir) {
    logger.error("✗ COA_DIR env var is required (path to folder of COA PDFs)")
    return
  }
  const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity

  let files: string[]
  try {
    const entries = await fs.readdir(dir)
    files = entries
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort()
      .slice(0, limit)
  } catch (e: any) {
    logger.error(`✗ Could not read directory ${dir}: ${e?.message ?? String(e)}`)
    return
  }
  logger.info(`▶ Found ${files.length} PDF(s) in ${dir}`)

  let totalIn = 0
  let totalOut = 0
  let parsed = 0
  let failed = 0

  for (const fileName of files) {
    const fullPath = path.join(dir, fileName)
    let pdfBytes: Buffer
    try {
      pdfBytes = await fs.readFile(fullPath)
    } catch (e: any) {
      logger.error(`  · ${fileName.padEnd(35)} READ ERROR: ${e?.message}`)
      failed += 1
      continue
    }

    const t0 = Date.now()
    const result = await extractCoa(pdfBytes)
    const elapsed = Date.now() - t0

    totalIn += result.inputTokens
    totalOut += result.outputTokens

    if (!result.ok) {
      logger.error(`  ✗ ${fileName.padEnd(35)} FAILED: ${result.error}`)
      failed += 1
      continue
    }
    parsed += 1
    const d = result.data!
    const thca = d.thcaPercent !== null ? `${d.thcaPercent.toFixed(2)}%`.padStart(8) : "(null)  "
    const cann = d.totalCannabinoidsPercent !== null ? `${d.totalCannabinoidsPercent.toFixed(2)}%`.padStart(8) : "(null)  "
    logger.info(
      `  · ${fileName.padEnd(35)} THCa: ${thca}  Cann: ${cann}  ${(elapsed / 1000).toFixed(1)}s` +
      (d.notes ? `\n      note: ${d.notes}` : ""),
    )
  }

  /* Sonnet 4.6 pricing (Apr 2026): $3/M input + $15/M output. */
  const costUsd = (totalIn / 1_000_000) * 3 + (totalOut / 1_000_000) * 15

  logger.info("─────────────── Summary ───────────────")
  logger.info(`parsed:        ${parsed}/${files.length}`)
  logger.info(`failed:        ${failed}`)
  logger.info(`total tokens:  in=${totalIn.toLocaleString()}  out=${totalOut.toLocaleString()}`)
  logger.info(`est. cost:     $${costUsd.toFixed(3)} for ${files.length} COAs (~$${(costUsd / files.length).toFixed(4)} each)`)
}

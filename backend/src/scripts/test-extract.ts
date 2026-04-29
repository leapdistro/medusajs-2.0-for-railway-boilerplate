import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { promises as fs } from "fs"
import path from "path"
import { extractInvoice } from "../lib/ai-extraction"

/**
 * End-to-end test for the AI invoice extractor. Reads a PDF from disk,
 * runs it through `extractInvoice`, and pretty-prints the structured
 * result + token usage. Use this to validate extraction quality on real
 * supplier invoices before wiring up the admin upload page (Slice 2B).
 *
 * Usage (local):
 *   INVOICE_PATH=/path/to/INV1121.pdf pnpm test:extract
 *
 * Usage (Railway shell):
 *   1. Upload the PDF somewhere readable (e.g. /tmp/inv.pdf via SCP or
 *      paste the base64 in a quick `cat > /tmp/inv.pdf`)
 *   2. INVOICE_PATH=/tmp/inv.pdf pnpm test:extract
 *
 * Default path falls back to ./test-invoice.pdf in the backend root.
 */
export default async function testExtract({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const invoicePath = process.env.INVOICE_PATH ?? path.resolve("./test-invoice.pdf")
  logger.info(`▶ Reading PDF: ${invoicePath}`)

  let pdfBytes: Buffer
  try {
    pdfBytes = await fs.readFile(invoicePath)
  } catch (e: any) {
    logger.error(`✗ Could not read PDF at ${invoicePath}: ${e?.message ?? String(e)}`)
    logger.error("  → Set INVOICE_PATH env var to a readable PDF file path.")
    return
  }
  logger.info(`✓ PDF loaded — ${pdfBytes.length.toLocaleString()} bytes`)

  logger.info("▶ Calling Anthropic extractor (Sonnet 4.6)…")
  const t0 = Date.now()
  const result = await extractInvoice(pdfBytes)
  const elapsed = Date.now() - t0

  logger.info("─────────────── Result ───────────────")
  logger.info(`elapsed:        ${elapsed}ms`)
  logger.info(`input_tokens:   ${result.inputTokens}`)
  logger.info(`output_tokens:  ${result.outputTokens}`)
  logger.info(`ok:             ${result.ok}`)

  if (!result.ok) {
    logger.error(`✗ Extraction failed: ${result.error}`)
    if (result.raw) {
      logger.error("─── Raw model response ───")
      logger.error(result.raw)
    }
    return
  }

  const data = result.data!
  logger.info("─────────────── Supplier ───────────────")
  logger.info(`name:    ${data.supplier.name}`)
  logger.info(`phone:   ${data.supplier.phone ?? "(null)"}`)
  logger.info(`email:   ${data.supplier.email ?? "(null)"}`)
  logger.info(`address: ${data.supplier.address ?? "(null)"}`)

  logger.info("─────────────── Invoice ───────────────")
  logger.info(`number:    ${data.invoiceNumber}`)
  logger.info(`date:      ${data.invoiceDate}`)
  logger.info(`subtotal:  ${data.subtotal ?? "(null)"}`)
  logger.info(`shipping:  ${data.shippingTotal}`)
  logger.info(`total:     ${data.total}`)
  if (data.notes) logger.info(`notes:     ${data.notes}`)

  logger.info(`─────────────── Line Items (${data.lineItems.length}) ───────────────`)
  let qtySum = 0
  let priceSum = 0
  for (const li of data.lineItems) {
    const lineTotal = li.quantityLb * li.unitPricePerLb
    qtySum += li.quantityLb
    priceSum += lineTotal
    logger.info(
      `  · ${li.strainName.padEnd(28)} ${li.quantityLb.toFixed(2).padStart(6)} lb  @ $${li.unitPricePerLb.toFixed(2).padStart(8)} /lb  = $${lineTotal.toFixed(2)}`,
    )
  }
  logger.info("─────────────── Totals ───────────────")
  logger.info(`sum(qty):       ${qtySum.toFixed(2)} lb`)
  logger.info(`sum(line $):    $${priceSum.toFixed(2)}`)
  logger.info(`+ shipping:     $${data.shippingTotal.toFixed(2)}`)
  logger.info(`= computed:     $${(priceSum + data.shippingTotal).toFixed(2)}`)
  logger.info(`vs invoice:     $${data.total.toFixed(2)}`)
  const delta = data.total - (priceSum + data.shippingTotal)
  if (Math.abs(delta) > 0.01) {
    logger.warn(`? Δ ${delta.toFixed(2)} — likely tax or rounding. Review.`)
  } else {
    logger.info("✓ totals reconcile")
  }

  logger.info("─────────────── Raw JSON ───────────────")
  logger.info(JSON.stringify(data, null, 2))
}

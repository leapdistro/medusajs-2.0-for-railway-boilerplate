import { PDFDocument } from "pdf-lib"

/**
 * Build a combined PDF containing every unique product's COA from an
 * order's line items.
 *
 * Behavior (mirrors the storefront implementation in
 * src/lib/coa-bundle.ts):
 *   - One COA per UNIQUE product (dedup by handle).
 *   - Line-item order preserved (first occurrence wins).
 *   - Missing COA → silently skip the product.
 *   - Image COAs (PNG / JPEG) auto-converted to single-page PDFs.
 *
 * COAs are fetched from the storefront's branded `/coa/<slug>`
 * streaming proxy — same artifact a QR-scanner end-customer would
 * see. We don't go direct-to-bucket because the proxy normalises
 * filename / content-type and is the canonical access path; using
 * it keeps the bundle output identical between buyer-side and
 * admin-side bundles.
 *
 * Caller passes the storefront base URL — typically STOREFRONT_URL
 * env var on Railway (set to https://hempmbs.com in prod).
 */
export type CoaBundleItem = {
  handle: string
  label?: string
}

export type CoaBundleResult = {
  pdf: Uint8Array
  included: string[]
  skipped: string[]
}

export async function buildCoaBundle(
  items: CoaBundleItem[],
  siteUrl: string,
): Promise<CoaBundleResult> {
  const seen = new Set<string>()
  const uniqueItems: CoaBundleItem[] = []
  for (const it of items) {
    if (!it.handle || seen.has(it.handle)) continue
    seen.add(it.handle)
    uniqueItems.push(it)
  }

  const out = await PDFDocument.create()
  const included: string[] = []
  const skipped: string[] = []

  for (const it of uniqueItems) {
    const url = `${siteUrl.replace(/\/$/, "")}/coa/${encodeURIComponent(it.handle)}`
    try {
      const res = await fetch(url, { cache: "no-store" })
      if (!res.ok) { skipped.push(it.handle); continue }
      const buf = new Uint8Array(await res.arrayBuffer())
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
      const ok = await embedCoa(out, buf, contentType)
      if (ok) included.push(it.handle)
      else skipped.push(it.handle)
    } catch {
      skipped.push(it.handle)
    }
  }

  const pdf = await out.save()
  return { pdf, included, skipped }
}

async function embedCoa(
  out: PDFDocument,
  buf: Uint8Array,
  contentType: string,
): Promise<boolean> {
  if (contentType.includes("pdf") || sniffPdf(buf)) {
    try {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true })
      const pageIndices = src.getPageIndices()
      const copied = await out.copyPages(src, pageIndices)
      for (const p of copied) out.addPage(p)
      return true
    } catch {
      return false
    }
  }
  const isJpeg = contentType.includes("jpeg") || contentType.includes("jpg") || sniffJpeg(buf)
  const isPng = contentType.includes("png") || sniffPng(buf)
  if (!isJpeg && !isPng) return false
  try {
    const image = isJpeg ? await out.embedJpg(buf) : await out.embedPng(buf)
    const pageW = 612
    const pageH = 792
    const margin = 36
    const maxW = pageW - margin * 2
    const maxH = pageH - margin * 2
    const aspect = image.width / image.height
    let w = maxW
    let h = maxW / aspect
    if (h > maxH) { h = maxH; w = maxH * aspect }
    const page = out.addPage([pageW, pageH])
    page.drawImage(image, {
      x: (pageW - w) / 2,
      y: (pageH - h) / 2,
      width: w,
      height: h,
    })
    return true
  } catch {
    return false
  }
}

function sniffPdf(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
}
function sniffJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}
function sniffPng(buf: Uint8Array): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
}

/**
 * Marketing email content model. An email is a list of blocks; the
 * renderer (email.tsx) draws each one with fixed brand styling, so the
 * admin chooses words, products and pictures, never colours or fonts.
 * Adding a block type = a type here + sanitize case + renderer case +
 * editor form. Saved campaigns keep working because unknown or bad
 * blocks are dropped on read, not thrown.
 */

export type HeadingBlock = { id: string; type: "heading"; text: string; highlight?: string }
/** Paragraphs split on blank lines; **bold** and [label](url) allowed. */
export type TextBlock = { id: string; type: "text"; text: string }
export type ButtonBlock = { id: string; type: "button"; label: string; url: string }
export type ImageBlock = { id: string; type: "image"; url: string; alt: string; link?: string }
export type ProductsBlock = {
  id: string
  type: "products"
  title?: string
  productIds: string[]
  layout: "grid" | "list"
  showPrices: boolean
}
export type SpacerBlock = { id: string; type: "spacer"; size: "s" | "m" | "l" }

export type Block = HeadingBlock | TextBlock | ButtonBlock | ImageBlock | ProductsBlock | SpacerBlock
export type BlockType = Block["type"]

export const BLOCK_TYPES: BlockType[] = ["heading", "text", "button", "image", "products", "spacer"]
export const MAX_BLOCKS = 40
export const MAX_PRODUCTS_PER_BLOCK = 24

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : Math.random().toString(36).slice(2, 10))

/** Only http(s) links, or a site path ("/products/flower"). */
export function safeUrl(v: unknown): string {
  const s = str(v, 2000).trim()
  if (!s) return ""
  if (s.startsWith("/") && !s.startsWith("//")) return s
  try {
    const u = new URL(s)
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : ""
  } catch {
    return ""
  }
}

export function sanitizeBlock(raw: any): Block | null {
  if (!raw || typeof raw !== "object") return null
  const base = { id: id(raw.id) }
  switch (raw.type) {
    case "heading": {
      const text = str(raw.text, 200)
      const highlight = str(raw.highlight, 80).trim()
      return { ...base, type: "heading", text, ...(highlight ? { highlight } : {}) }
    }
    case "text":
      return { ...base, type: "text", text: str(raw.text, 5000) }
    case "button":
      return { ...base, type: "button", label: str(raw.label, 60), url: safeUrl(raw.url) }
    case "image": {
      const link = safeUrl(raw.link)
      return { ...base, type: "image", url: safeUrl(raw.url), alt: str(raw.alt, 200), ...(link ? { link } : {}) }
    }
    case "products": {
      const ids = Array.isArray(raw.productIds) ? raw.productIds : []
      const productIds = [...new Set(ids.filter((x: unknown) => typeof x === "string" && /^prod_[A-Za-z0-9]{6,64}$/.test(x as string)))]
        .slice(0, MAX_PRODUCTS_PER_BLOCK) as string[]
      const title = str(raw.title, 120)
      return {
        ...base,
        type: "products",
        ...(title ? { title } : {}),
        productIds,
        layout: raw.layout === "list" ? "list" : "grid",
        showPrices: raw.showPrices !== false,
      }
    }
    case "spacer":
      return { ...base, type: "spacer", size: raw.size === "s" || raw.size === "l" ? raw.size : "m" }
    default:
      return null
  }
}

export function sanitizeBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitizeBlock).filter((b): b is Block => !!b).slice(0, MAX_BLOCKS)
}

export function productIdsOf(blocks: Block[]): string[] {
  return [...new Set(blocks.flatMap((b) => (b.type === "products" ? b.productIds : [])))]
}

/* ───────────── Audience ───────────── */

/**
 * Who a campaign goes to. Always approved customers only (owner,
 * 2026-11-25), minus the suppression list.
 *   all    — every approved customer
 *   filter — approved customers matching every non-empty list
 *            (pricing mode, state, business type)
 *   pick   — only the customers ticked by hand
 * `exclude` removes ticked customers in any mode.
 */
export type Audience = {
  mode: "all" | "filter" | "pick"
  pricingModes: string[] // "default" | "owner_stores" | "distro" | "tier_2" | "tier_3" | "cbd_cbg"
  states: string[]
  businessTypes: string[]
  customerIds: string[]
  exclude: string[]
}

const list = (v: unknown, max = 500) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && x.length <= 120) as string[])].slice(0, max) : []

export function sanitizeAudience(raw: any): Audience {
  const r = raw && typeof raw === "object" ? raw : {}
  return {
    mode: r.mode === "filter" || r.mode === "pick" ? r.mode : "all",
    pricingModes: list(r.pricingModes, 10),
    states: list(r.states, 60).map((s) => s.toUpperCase()),
    businessTypes: list(r.businessTypes, 50),
    customerIds: list(r.customerIds, 5000),
    exclude: list(r.exclude, 5000),
  }
}

export const EMPTY_AUDIENCE: Audience = { mode: "all", pricingModes: [], states: [], businessTypes: [], customerIds: [], exclude: [] }

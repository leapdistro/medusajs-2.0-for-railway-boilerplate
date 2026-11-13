/**
 * Brands (owner, 2026-11-12). A third-party brand (RAW, Zig-Zag, …) is a
 * Medusa product collection: one brand per product, picked in the
 * product's Organize section. Mind Body Spirit's own products have no
 * collection and keep the tier look.
 *
 * The collection page's "Storefront display" widget saves the keys in
 * BrandMeta on the collection's metadata. /store/mbs/products sends each
 * product's brand with its shades, so the storefront colours the brand's
 * cards and pages without any per-brand code.
 */

export type BrandMeta = {
  /** The brand's main colour, "#RRGGBB". */
  color?: string
  description?: string
  /** Logo image URL (uploaded in the widget). */
  logo?: string
  /** We're an authorized retailer of the brand. */
  authorized?: boolean
}

/** The three shades a tier has (swatch, surface, edge), for one brand. */
export type BrandShades = { swatch: string; surface: string; edge: string }

export type StoreBrand = {
  handle: string
  name: string
  description: string | null
  logo: string | null
  authorized: boolean
  shades: BrandShades | null
}

const HEX = /^#[0-9a-f]{6}$/i
export const isBrandColor = (v: unknown): v is string => typeof v === "string" && HEX.test(v)

/* Storefront tokens the tier shades are mixed against (mbs-storefront
 * globals.css: --mbs-white, --mbs-paper, --mbs-black). */
const CARD_WHITE = "#FFFDF7"
const PAPER = "#FFF9ED"
const INK = "#171B14"

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const toHex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()
/** `share` of `a`, the rest `b`. */
const mix = (a: string, b: string, share: number) => {
  const [x, y] = [rgb(a), rgb(b)]
  return toHex(x.map((v, i) => v * share + y[i] * (1 - share)))
}
/** WCAG relative luminance, 0 (black) to 1 (white). */
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Step `color` toward `target` until `ok` holds for its luminance. */
const toward = (color: string, target: string, ok: (l: number) => boolean) => {
  let c = color
  for (let i = 0; i < 60 && !ok(luminance(c)); i++) c = mix(c, target, 0.97)
  return c
}

/**
 * The tier proportions applied to a brand colour: surface is 20% of the
 * colour on card white, edge 77% on paper (e.g. Super #DD6A5E gives
 * #F8E0D8 / #E58B7F, the tokens being #F8DEDA / #E38B80). Then each is
 * kept in the brightness range the tier shades sit in, so any brand
 * colour reads like a tier: the surface stays light but visible
 * (luminance 0.75–0.88, tier surfaces are 0.77–0.83): a black or navy
 * brand doesn't darken the photo area, and a cream one still shows
 * against the paper page (0.95). The edge
 * stays mid-tone (0.15–0.45, tier edges are 0.34–0.44): darkened with
 * ink for a pale brand, or it would vanish on the paper page, lightened
 * with paper for a near-black one, or it would merge with the ink outline.
 */
export function brandShades(color: string): BrandShades {
  let surface = mix(color, CARD_WHITE, 0.2)
  surface = toward(surface, CARD_WHITE, (l) => l >= 0.75)
  surface = toward(surface, INK, (l) => l <= 0.88)
  let edge = mix(color, PAPER, 0.77)
  edge = toward(edge, INK, (l) => l <= 0.45)
  edge = toward(edge, PAPER, (l) => l >= 0.15)
  return { swatch: color.toUpperCase(), surface, edge }
}

/** The storefront's view of a product's collection; null when it has none. */
export function storeBrand(collection: { handle?: string | null; title?: string | null; metadata?: Record<string, unknown> | null } | null | undefined): StoreBrand | null {
  if (!collection?.handle || !collection.title) return null
  const m = (collection.metadata ?? {}) as BrandMeta
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  return {
    handle: collection.handle,
    name: collection.title,
    description: text(m.description),
    logo: text(m.logo),
    authorized: m.authorized === true,
    shades: isBrandColor(m.color) ? brandShades(m.color) : null,
  }
}

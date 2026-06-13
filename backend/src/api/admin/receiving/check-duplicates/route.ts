import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findNearMatches, normalizeForMatch, type NearMatch } from "../../../../lib/fuzzy-match"

/**
 * POST /admin/receiving/check-duplicates
 *
 * Two supported body shapes (backwards-compatible):
 *
 *   1. Legacy:  { strainNames: string[] }
 *      Returns: { matches: { [strainName]: NearMatch[] } } — fuzzy only.
 *      Kept so older callers keep working.
 *
 *   2. New:     { rows: Array<{ strainName, tier? }> }
 *      Returns: { matches: Array<MatchClassification> }
 *      Per-row classification:
 *        - restock:      strainSlug matches an existing receiving-created
 *                        product AND tier matches → safe restock target
 *        - tierConflict: strainSlug matches an existing product but tier
 *                        differs → operator would create a NEW product
 *                        in a different tier (often unintended)
 *        - near:         no exact match, but Levenshtein-close fuzzy
 *                        match(es) — likely typo
 *
 * The receiving page uses the new shape for real-time row checks +
 * pre-save validation; the older shape is still hit on initial extract.
 */

const TIER_PREFIXES = ["classic-", "exotic-", "super-", "snow-", "rapper-"] as const
type TierKey = "classic" | "exotic" | "super" | "snow" | "rapper"

type ProductCandidate = {
  productId: string
  handle: string
  title: string
  /** Tier derived from handle prefix (post-2026-06-13 style) OR from
   *  the product's category link (legacy products without prefix). */
  tier: TierKey | null
}

type MatchClassification = {
  /** Strain name as the operator typed it — echoed back for client-side
   *  binding when rows are reordered or filtered. */
  strainName: string
  tier: string | null
  /** Same strainSlug + same tier as an existing product → restock target. */
  restock: { productId: string; handle: string; title: string; tier: TierKey } | null
  /** Same strainSlug but at a DIFFERENT tier — accidental new-product creation risk. */
  tierConflict: { productId: string; handle: string; title: string; tier: TierKey } | null
  /** Fuzzy (Levenshtein) matches — typos. */
  near: NearMatch[]
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as {
    strainNames?: string[]
    rows?: Array<{ strainName?: string; tier?: string }>
  }

  /* Build the candidate set once — every classification needs it. */
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title", "categories.handle"],
  })

  const candidates: ProductCandidate[] = []
  for (const p of products as any[]) {
    const handle = (p.handle ?? "").toLowerCase()
    const prefix = TIER_PREFIXES.find((pre) => handle.startsWith(pre))
    if (prefix) {
      candidates.push({
        productId: p.id,
        handle,
        title: p.title ?? "",
        tier: prefix.replace("-", "") as TierKey,
      })
    } else {
      /* Legacy product (handle doesn't carry tier). Use the product's
       * category to infer tier — flower-tier categories use the same
       * lowercase handle (classic / exotic / super / snow / rapper). */
      const cats = (p.categories ?? []) as Array<{ handle?: string }>
      const tierCat = cats.find((c) => TIER_PREFIXES.some((pre) => c?.handle === pre.replace("-", "")))
      candidates.push({
        productId: p.id,
        handle,
        title: p.title ?? "",
        tier: (tierCat?.handle as TierKey) ?? null,
      })
    }
  }

  /* ─── New shape ─── */
  if (Array.isArray(body.rows)) {
    const out: MatchClassification[] = body.rows.map((r) => {
      const strain = String(r?.strainName ?? "")
      const tier = r?.tier ? String(r.tier) : null
      const key = normalizeForMatch(strain)
      if (!key) {
        return { strainName: strain, tier, restock: null, tierConflict: null, near: [] }
      }
      /* Exact-slug matches across the catalog. */
      const exact = candidates.filter((c) => normalizeForMatch(c.title) === key)
      const restockMatch = tier ? exact.find((c) => c.tier === tier) : undefined
      const otherTier = exact.filter((c) => c.tier !== tier)
      const near = findNearMatches(strain, candidates.filter((c) => c.tier).map((c) => ({
        handle: c.handle, title: c.title, tier: c.tier as string,
      })))
      return {
        strainName: strain,
        tier,
        restock: restockMatch
          ? { productId: restockMatch.productId, handle: restockMatch.handle, title: restockMatch.title, tier: restockMatch.tier as TierKey }
          : null,
        /* Show first conflicting tier (if multiple) — UI lists them all
         * via the near[] field too. */
        tierConflict: !restockMatch && otherTier.length > 0
          ? { productId: otherTier[0].productId, handle: otherTier[0].handle, title: otherTier[0].title, tier: otherTier[0].tier as TierKey }
          : null,
        near,
      }
    })
    res.json({ matches: out })
    return
  }

  /* ─── Legacy shape (strainNames-only fuzzy) ─── */
  const names = Array.isArray(body.strainNames) ? body.strainNames : []
  if (names.length === 0) {
    res.json({ matches: {} })
    return
  }
  const legacyCandidates = candidates
    .filter((c) => c.tier !== null && TIER_PREFIXES.some((pre) => c.handle.startsWith(pre)))
    .map((c) => ({ handle: c.handle, title: c.title, tier: c.tier as string }))
  const matches: Record<string, NearMatch[]> = {}
  for (const name of names) {
    const result = findNearMatches(name, legacyCandidates)
    if (result.length > 0) matches[name] = result
  }
  res.json({ matches })
}

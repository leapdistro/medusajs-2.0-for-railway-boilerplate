import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findNearMatches } from "../../../../lib/fuzzy-match"

/**
 * POST /admin/receiving/check-duplicates
 *
 * Body: { strainNames: string[] }
 *
 * Returns per-input near-matches against the existing flower catalog
 * (handles starting with a tier prefix). Used by the receiving review
 * page to flag rows where the AI's strain name is one typo away from
 * an existing product — operator should restock instead of create new.
 *
 * Returns:
 *   { matches: { [strainName]: NearMatch[] } }
 *   where NearMatch = { handle, title, tier, distance }
 */

const TIER_PREFIXES = ["classic-", "exotic-", "super-", "snow-", "rapper-"]

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as { strainNames?: string[] }
  const names = Array.isArray(body.strainNames) ? body.strainNames : []
  if (names.length === 0) {
    res.json({ matches: {} })
    return
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["handle", "title"],
  })

  /* Filter to receiving-created products (handle starts with tier
   * prefix) and split out the tier from the strain part. Manual
   * products with freeform handles are excluded — fuzzy-matching
   * against them risks false positives across categories. */
  const candidates: Array<{ handle: string; title: string; tier: string }> = []
  for (const p of products as any[]) {
    const handle = (p.handle ?? "").toLowerCase()
    const prefix = TIER_PREFIXES.find((pre) => handle.startsWith(pre))
    if (!prefix) continue
    candidates.push({
      handle,
      title: p.title ?? "",
      tier: prefix.replace("-", ""),
    })
  }

  const matches: Record<string, ReturnType<typeof findNearMatches>> = {}
  for (const name of names) {
    const result = findNearMatches(name, candidates)
    if (result.length > 0) matches[name] = result
  }

  res.json({ matches })
}

/**
 * Tiny string-similarity helper for catching strain-name typos at
 * receiving time (e.g., AI extracts "Austrain Gold" but the catalog
 * has "Australian Gold" — operator should restock, not create new).
 *
 * Pure function, no dependencies. Levenshtein distance + a small
 * normalize step (lowercase, strip non-alphanum, collapse to a flat
 * key) so that punctuation / spacing don't poison the comparison.
 */

/** Slug → flat lowercase alphanum, matches receiving-save's slugify. */
export function normalizeForMatch(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

/** Standard Levenshtein DP. O(n*m). Inputs typically <40 chars so trivial. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  /* Two-row DP — keeps memory O(min(n, m)). */
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i)
  let curr = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,         // insertion
        prev[j] + 1,             // deletion
        prev[j - 1] + cost,      // substitution
      )
    }
    [prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

export type NearMatch = {
  handle: string
  title: string
  tier: string
  distance: number
}

/**
 * For one input strain name, return up to N existing products whose
 * normalized title is close enough to be a likely typo. Threshold is
 * distance ≤ 3 OR distance/length ≤ 0.25 — empirically these catch
 * "Austrain Gold ↔ Australian Gold" (distance 2) and "Mac n Cheese ↔
 * Mac and Cheese" (distance 3) without flagging unrelated strains.
 */
export function findNearMatches(
  inputName: string,
  candidates: Array<{ handle: string; title: string; tier: string }>,
  opts: { maxResults?: number; maxDistance?: number; maxRatio?: number } = {},
): NearMatch[] {
  const max = opts.maxResults ?? 3
  const maxDist = opts.maxDistance ?? 3
  const maxRatio = opts.maxRatio ?? 0.25
  const inputKey = normalizeForMatch(inputName)
  if (!inputKey) return []

  const scored: NearMatch[] = []
  for (const c of candidates) {
    const candKey = normalizeForMatch(c.title)
    if (!candKey) continue
    /* Exact slug match → already a duplicate. Caller's restock logic
     * will handle it; no warning needed here. */
    if (candKey === inputKey) continue
    const dist = levenshtein(inputKey, candKey)
    const ratio = dist / Math.max(inputKey.length, candKey.length)
    if (dist <= maxDist || ratio <= maxRatio) {
      scored.push({ handle: c.handle, title: c.title, tier: c.tier, distance: dist })
    }
  }
  scored.sort((a, b) => a.distance - b.distance)
  return scored.slice(0, max)
}

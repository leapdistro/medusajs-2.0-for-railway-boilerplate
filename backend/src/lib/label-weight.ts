/**
 * Grams in a label format ("3.5g" → 3.5); null for formats that aren't a
 * gram weight (QP). Dependency-free so both the backend and the admin
 * bundle (MBS Settings → Packaging Planner) read sizes the same way.
 */
export function formatGrams(f: { id?: unknown; weight_text?: unknown }): number | null {
  for (const s of [f.weight_text, f.id]) {
    const m = String(s ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*g$/i)
    if (m) return Number(m[1])
  }
  return null
}

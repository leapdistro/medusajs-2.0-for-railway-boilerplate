import { loadCategoryTree, type TreeCategory } from "./category-tree"

/**
 * Product-line retire / reactivate — line registry + reason codes.
 *
 * A "product line" is any category directly under a top-level category
 * (Flower → CBD, Flower → CBG, Pre-Rolls → CBD, …), read live from
 * Medusa, so a category added in admin is a line with no code change.
 * Retiring a line deactivates it and every category below it, drafts
 * its published products, and writes an audit entry; reactivate
 * reverses exactly that.
 */

export type ProductLine = {
  /** The line category's handle — the key in API calls and the audit log. */
  key: string
  /** "CBD Flower": the line's name, then its top-level category's. */
  displayName: string
  /** The line category and every category below it. */
  categories: TreeCategory[]
  handles: string[]
  /** The line category itself (its is_active drives the "unknown" state). */
  line: TreeCategory
}

export async function loadProductLines(query: any): Promise<ProductLine[]> {
  const tree = await loadCategoryTree(query)
  const all = [...tree.byId.values()]
  const childrenOf = (id: string) => all.filter((c) => c.parent_category_id === id)
  const lines: ProductLine[] = []
  for (const top of all.filter((c) => !c.parent_category_id)) {
    for (const line of childrenOf(top.id).sort((a, b) => a.name.localeCompare(b.name))) {
      const categories: TreeCategory[] = []
      const stack = [line]
      while (stack.length > 0) {
        const c = stack.pop()!
        categories.push(c)
        stack.push(...childrenOf(c.id))
      }
      lines.push({
        key: line.handle,
        displayName: `${line.name} ${top.name}`,
        categories,
        handles: categories.map((c) => c.handle),
        line,
      })
    }
  }
  return lines
}

/** Reason codes for the retire modal. Kept hardcoded (not editable via
 *  MBS Settings) since these map to legal/regulatory categories that
 *  should stay stable across audits. If ops needs a new code that isn't
 *  covered, add it here — the audit log preserves the raw code string
 *  so old entries stay valid after additions. */
export const REASON_CODES = [
  { id: "texas_sb3",           label: "Texas SB3 (total-THC rule)" },
  { id: "state_rule_change",   label: "State rule change (other state)" },
  { id: "federal_rule_change", label: "Federal rule change (Farm Bill / DEA / etc.)" },
  { id: "legal_hold",          label: "Legal hold (pending litigation)" },
  { id: "supply_shortage",     label: "Supply shortage" },
  { id: "discontinued",        label: "Discontinued product line" },
  { id: "seasonal_pause",      label: "Seasonal pause" },
  { id: "other",               label: "Other (see notes)" },
] as const

export type ReasonCode = typeof REASON_CODES[number]["id"]
export const REASON_CODE_IDS: readonly ReasonCode[] = REASON_CODES.map((r) => r.id)

export type AuditAction = "retire" | "reactivate"

/** One row in the product_line_audit log. Kept small enough to serialize
 *  cleanly as JSON inside mbs-settings; adds up to a few KB per entry
 *  even with a few thousand productIds captured. */
export type ProductLineAuditEntry = {
  id: string                    // uuid
  timestamp: string             // ISO8601
  actor: string                 // admin user id / email / "unknown_admin"
  action: AuditAction
  /** The line's key (its category handle). */
  branch: string
  reason: ReasonCode
  notes?: string
  /** Category ids this action switched active/inactive (retire records
   *  only those it turned off, so reactivate leaves already-off ones off).
   *  Used by reactivate to reverse a matching retire precisely — if a
   *  new tier category was added after retire and reactivate is run
   *  later, that new cat won't accidentally get activated. */
  categoryIds: string[]
  /** Product ids that had `status` changed during this action. Retire
   *  captures every currently-published product in the branch subtree
   *  so reactivate only re-publishes THOSE (not products added after
   *  retire, and not products that were already draft/archived). */
  productIds: string[]
  /** Summary of the write outcome. */
  categoriesToggled: number
  productsUpdated: number
}

export const AUDIT_SETTING_KEY = "product_line_audit"

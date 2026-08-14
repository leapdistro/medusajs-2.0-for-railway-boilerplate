/**
 * Product-line retire / reactivate — shared branch registry + reason codes.
 *
 * A "product line" here = one cannabinoid branch under Flower. Each branch
 * carries its own Medusa category subtree, and retiring it is a routine
 * ops action (state rule change, litigation stay, seasonal pause). The
 * retire flow deactivates categories, bulk-unpublishes products, and
 * writes an audit entry so future ops can see who did what and when.
 *
 * Only Flower branches today. Pre-Rolls, hashholes, or future categories
 * can be added by extending the BRANCHES map — the retire/reactivate
 * endpoints are branch-generic.
 *
 * WHY the branches are hardcoded here rather than derived from Medusa:
 * category HANDLES aren't semantically-typed on the Medusa side (they're
 * globally-unique strings), so a code-side registry gives us a stable
 * enum for API validation + admin UI labeling. Adding a new branch means
 * editing this file — infrequent enough to be worth the explicit step.
 */

/** Cannabinoid branch keys — matches the storefront's FlowerType union
 *  so /store/mbs/tier-prices, adapter, PDP labels, etc. all speak the
 *  same vocabulary. Add here when a new branch launches; do NOT rename
 *  without a coordinated storefront + audit-log migration. */
export type BranchKey = "thc-a" | "thc-p" | "cbd" | "cbg"

export type BranchDef = {
  key: BranchKey
  displayName: string
  /** Handle of the intermediate category under Flower. THC-A / CBD / CBG
   *  own their tier ladders under this handle; THC-P is a leaf so its
   *  intermediate handle IS its final handle ("thc-p"). */
  intermediateHandle: string
  /** Handles of the tier children (5 for tier-ladder branches, empty
   *  for leaf branches like THC-P). Used by buildContext to identify
   *  every category id involved in a retire/reactivate cycle. */
  tierHandles: string[]
}

export const BRANCHES: Record<BranchKey, BranchDef> = {
  "thc-a": {
    key: "thc-a",
    displayName: "THC-A Flower",
    intermediateHandle: "flower-thc-a",
    /* Bare tier handles predate the CBD/CBG split — THC-A tier children
     * still carry the original single-word slugs (globally-unique;
     * CBD/CBG had to prefix theirs). */
    tierHandles: ["classic", "exotic", "super", "snowcaps", "rapper"],
  },
  "thc-p": {
    key: "thc-p",
    displayName: "THC-P Flower",
    intermediateHandle: "thc-p",
    /* Leaf branch — case-pack, no tier ladder. */
    tierHandles: [],
  },
  cbd: {
    key: "cbd",
    displayName: "CBD Flower",
    intermediateHandle: "flower-cbd",
    /* Branch-prefixed tier handles (post-2026-08 rollout — bare tier
     * slugs were already claimed by THC-A). */
    tierHandles: ["cbd-classic", "cbd-exotic", "cbd-super", "cbd-snowcaps", "cbd-rapper"],
  },
  cbg: {
    key: "cbg",
    displayName: "CBG Flower",
    intermediateHandle: "flower-cbg",
    tierHandles: ["cbg-classic", "cbg-exotic", "cbg-super", "cbg-snowcaps", "cbg-rapper"],
  },
}

/** Every handle involved in a branch's retire/reactivate — intermediate
 *  + tier children — as one flat list. */
export function allHandlesForBranch(branch: BranchKey): string[] {
  const def = BRANCHES[branch]
  return [def.intermediateHandle, ...def.tierHandles]
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
  branch: BranchKey
  reason: ReasonCode
  notes?: string
  /** Category ids that were toggled active/inactive during this action.
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

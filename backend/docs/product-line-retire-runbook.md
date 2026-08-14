# Product Line Retire / Reactivate — Ops Runbook

**Audience:** whoever's on-call when a state or federal cannabinoid rule changes.
**Command:** [MBS Admin → Product Lines](/app/product-lines) — one click per branch.
**Fallback:** direct API — `POST /admin/product-lines/retire` or `/reactivate` with `{ branch, reason, notes? }`.

Retire ≠ delete. Products stay in the database with `status: draft`; categories stay with `is_active: false`; every action is captured in an audit log so future ops (or a regulator) can see who, when, and why.

---

## When to retire a branch

| Trigger | Branch | Reason code | Notes |
|---|---|---|---|
| **Texas SB3** passes / takes effect | `thc-a` | `texas_sb3` | Case number, effective date, litigation status |
| Other state passes total-THC rule | affected branch | `state_rule_change` | State + statute reference |
| Farm Bill amendment / DEA scheduling | affected branch | `federal_rule_change` | Bill number, section |
| Court injunction paused, awaiting appeal | affected branch | `legal_hold` | Court, case #, next hearing date |
| Long supply gap (weeks+) | affected branch | `supply_shortage` | Supplier, expected restock ETA |
| Product line permanently killed | affected branch | `discontinued` | Business decision |
| Seasonal pause | affected branch | `seasonal_pause` | Return date |
| Other | affected branch | `other` | ALWAYS fill notes |

**When NOT to retire:**
- One or two SKUs unavailable — use per-product `status: draft` in standard Medusa admin.
- Price change — use MBS Settings → Tier Prices tabs.
- Reactivating a category deactivated outside this system — go to `/app/product-lines`, look for the "state drift" warning, retire from there so the audit entry gets written cleanly.

---

## Retire — happy path

1. Open [Admin → Product Lines](/app/product-lines).
2. Find the affected branch row (state pill shows `Active`).
3. Click **Retire**.
4. Pick the reason code that best matches. If nothing fits, use `other` and put the specifics in Notes.
5. Notes: paste the case number, statute reference, ticket URL — anything future-you will want when reading the audit log a year from now.
6. **Yes, Retire**.
7. Wait for the toast: `Retired · N products, M categories`.
8. Verify at the storefront within ~60s (ISR cache):
   - Home page: branch tile gone
   - Mega menu: branch sub-column gone
   - `/products?category=flower`: cannabinoid chip gone
   - Direct PDP URL (e.g. `/products/flower/classic/blue-dream`): renders soft-404 "product unavailable" fallback
   - `/coas`: branch chip gone; branch's COAs no longer listed
9. Admin bell will show `<Branch> retired`. Compliance stakeholders (if any) get the same notification.

## Reactivate — happy path

1. Same page, retired row's action button now says **Reactivate**.
2. Pick a reason: `legal_hold` if litigation stayed the rule, `state_rule_change` if the rule was rolled back, etc.
3. Notes: link the ruling / statute change / whatever unblocked reactivation.
4. **Yes, Reactivate**.
5. Toast: `Reactivated · N products, M categories`.
6. Verify at the storefront: branch tile, mega menu, filters all reappear.

Reactivate re-publishes **only the products that the matching retire drafted** — anything added in draft state during the retirement period stays in draft. Categories that were added to the branch tree after retire also stay inactive (they weren't in the retire's captured `categoryIds`). If you need those live, activate them by hand in the standard Medusa admin.

---

## What retire actually does under the hood

For a given `branch`:

1. Look up the branch's intermediate category + tier children by handle (from `BRANCHES` in `backend/src/lib/product-lines.ts`).
2. `updateProductCategoriesWorkflow` → `is_active: false` on each.
3. `graph({ entity: "product" })` filter → every product with `status: "published"` in the branch subtree.
4. `updateProductsWorkflow` → `status: "draft"` on all of them.
5. Append audit entry to `mbs-settings.product_line_audit`:
   ```json
   {
     "id": "uuid",
     "timestamp": "ISO",
     "actor": "admin-user-id",
     "action": "retire",
     "branch": "thc-a",
     "reason": "texas_sb3",
     "notes": "...",
     "categoryIds": [ ... ],
     "productIds": [ ... ],
     "categoriesToggled": 6,
     "productsUpdated": 42
   }
   ```
6. Fire `feed`-channel notification to the admin bell.

Reactivate reverses steps 2 and 4 using `categoryIds` + `productIds` from the most recent retire entry.

---

## What retire does NOT touch (intentional)

- **Order history** — historical invoices, order detail pages, past receiving records all keep resolving via snapshot data.
- **QR-code label URLs** — `/coa/<slug>` proxy stays public so packaging scans from the field keep working.
- **QBO Items** — historical Items stay in QuickBooks with their existing Category chain. Reactivate doesn't re-create them.
- **Storefront type unions + adapter branches** — `FlowerType`/`Cannabinoid` still list the retired key; adapter still recognises historical products.
- **MBS Settings price tables** — `flower_tier_prices` / `flower_cbd_prices` etc. stay editable so ops can pre-set prices before reactivation.
- **Receiving profiles** — `FLOWER_PROFILE` config stays in `receiving-profiles.ts`. The switcher's `CANNABINOID_OPTIONS` list is the operator-facing filter (needs a manual code change to add a retired branch back — see below).

## What DOES need a manual code change to fully reactivate a branch

The storefront UI has a couple of hardcoded allowlists that don't derive from Medusa's category tree:

- `pickCannabinoid` validators in `src/components/shop/ShopPage.tsx` + `src/components/shop/CategoryOverview.tsx` — restrict URL params to `cbd | cbg`
- `FLOWER_CANNABINOIDS` in `src/components/shop/CoaLibrary.tsx`
- `FLOWER_INTERMEDIATES` in `src/app/products/page.tsx` + `src/components/layout/Header.tsx`
- `CANNABINOID_OPTIONS` in `backend/src/admin/routes/receiving/page.tsx`
- Static copy: `src/app/layout.tsx` title/desc, `src/app/about/page.tsx`, `src/app/faq/page.tsx`

For the THC-A retire commit (2026-08), all of these were changed together — revert that commit to restore. Same for THC-P.

---

## Troubleshooting

**State pill shows `Unknown`**
The branch's intermediate category is inactive in Medusa but no audit entry exists — someone deactivated it outside this system. Fix: click **Retire** from this dashboard (captures the audit entry cleanly), OR reactivate the category directly in Medusa admin if the deactivation was accidental.

**Retire succeeded, storefront still shows the branch**
ISR cache on Vercel holds the category tree for ~60s. Give it a minute; if it persists, redeploy the storefront (empty commit + push).

**Reactivate says "No prior retire entry"**
The branch was never retired via this system. Either:
- Nothing to reactivate (branch was already active) — check the state pill.
- The branch was retired via direct DB edit / raw Medusa admin — the audit log doesn't have a matching entry. Reactivate the intermediate + tier categories by hand in Medusa, and republish products in bulk via the standard product listing (filter by category, bulk edit status).

**One product per branch got missed by reactivate**
The product was archived or deleted between retire and reactivate. Republish it manually — retire's captured `productIds` only re-publish products still in `draft` state (safe: it won't clobber a `status: archived` explicit operator choice).

**Retire touched categories that shouldn't have been in the branch**
Check `BRANCHES` in `backend/src/lib/product-lines.ts` — the tier handles list should match what's in Medusa. Handle mismatch (typo, unseeded tier) means a category isn't found, not that a wrong category is touched.

---

## When the runbook needs updating

- New branch launched → add to `BRANCHES` in `backend/src/lib/product-lines.ts` + this table above.
- New reason code added → add to `REASON_CODES` in the same file, and to `REASON_OPTIONS` in `backend/src/admin/routes/product-lines/page.tsx` (kept duplicated so the admin bundle doesn't cross-compile from src/lib).
- Storefront UI adds a new place that hardcodes a cannabinoid allowlist → append it to the "manual code change" section above.

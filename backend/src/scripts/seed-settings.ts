import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"

/**
 * Seed default values for every system_setting key the rest of the app
 * reads. Idempotent — only writes a key if it doesn't already exist, so
 * operator edits are never clobbered by re-runs.
 *
 * Add a new setting? Add it here AND to the admin widget. The seed
 * gives the admin something to edit on first install; the widget gives
 * the operator a way to override it.
 *
 * Run via: pnpm seed:settings
 */

const DEFAULTS: Array<{
  key: string
  description: string
  value: unknown
}> = [
  {
    key: "payment_info",
    description: "Payment instructions shown in customer-facing order emails (Check / Wire / Net Terms).",
    value: {
      dba: "MBS LLC",
      mailing_address: "13220 Murphy Rd, Suite 100, Stafford, TX 77477",
      bank: {
        bank_name: "",
        beneficiary_name: "MBS LLC",
        routing_number: "",
        account_number: "",
        swift_code: "",
        account_type: "checking",
      },
      net_terms_default: "Net 30 — invoice attached. Pay via check, wire, or ACH by the due date.",
      memo_instruction: "Include 'Order #N' on the memo line so we can apply your payment.",
    },
  },
  {
    key: "contact_info",
    description: "Contact details shown in email footers and 'reach out' CTAs.",
    value: {
      support_email: "wholesale@hempmbs.com",
      support_phone: "",
      hours: "Mon–Fri 9am–5pm CT",
    },
  },
  {
    key: "cancellation_reasons",
    description: "Reasons the operator picks from when cancelling an order. Buyer sees the label in the cancellation email.",
    value: [
      { id: "out_of_stock",       label: "Out of stock",       archived: false },
      { id: "payment_failed",     label: "Payment failed",     archived: false },
      { id: "customer_request",   label: "Customer request",   archived: false },
      { id: "compliance_hold",    label: "Compliance hold",    archived: false },
      { id: "address_unverified", label: "Address unverified", archived: false },
    ],
  },
  {
    key: "denial_reasons",
    description: "Reasons the operator picks from when denying a wholesale application. Applicant sees the label in the denial email.",
    value: [
      { id: "missing_license",         label: "Missing or expired license",      archived: false },
      { id: "out_of_service_area",     label: "Out of service area",             archived: false },
      { id: "incomplete_documentation",label: "Incomplete documentation",        archived: false },
      { id: "not_a_fit",               label: "Not a fit at this time",          archived: false },
      { id: "duplicate_application",   label: "Duplicate application",           archived: false },
    ],
  },
  {
    key: "business_types",
    description: "Buyer-selectable business categories on the wholesale application. Used to validate the apply form's business_type field and to render the dropdown options. Operator can add / archive entries in admin settings.",
    value: [
      /* smoke_shop id retained (was "Smoke Shop") — relabeled to
       * Smoke/Vape Shop to fold vape into the same bucket. Existing
       * applications referencing the smoke_shop id keep resolving. */
      { id: "smoke_shop",   label: "Smoke/Vape Shop", archived: false },
      /* C-Store — new, primary corner-store accounts. */
      { id: "c_store",      label: "C-Store",         archived: false },
      { id: "dispensary",   label: "Dispensary",      archived: false },
      { id: "tobacco_shop", label: "Tobacco Shop",    archived: false },
      { id: "ecommerce",    label: "E-commerce",      archived: false },
      { id: "wholesale",    label: "Wholesale",       archived: false },
      { id: "distro",       label: "Distro",          archived: false },
      /* vape_shop archived — historical applications keep resolving
       * the id; new applications go through the merged Smoke/Vape
       * Shop entry above. NOT deleted so old data still has a
       * label to render. */
      { id: "vape_shop",    label: "Vape Shop",       archived: true },
    ],
  },
  {
    key: "shipping_rates",
    description: "Flat shipping cost (USD) per variant size. Receiving stamps the rate × 100 (cents) onto variant.weight on new variants; admin can bulk-apply to existing variants via MBS Settings → Shipping Rates → Apply to All Variants. The fulfillment provider sums variant.weight × quantity / 100 at checkout to compute the total shipping cost for the cart. Operators can override per-variant in admin (variant.weight is integer cents). Per-gram pricing display reads metadata.net_grams — independent.",
    value: {
      /* Per-variant-type shipping cost in whole USD. Operator adjusts in
       * admin → MBS Settings → Shipping Rates. A cart with 2× QP +
       * 1× LB at the defaults below = $20 + $20 + $50 = $90 shipping. */
      flower: {
        qp:   20,
        half: 35,
        lb:   50,
      },
      /* Pre-roll: keyed by (subcategory key → variant sizeKey → dollars).
       * Subcategories live-merged from Medusa in the admin UI so new
       * subcategories appear automatically with a 0 default. */
      preroll: {
        "thc-a": {
          "30pk": 25,
        },
        "hashholes": {
          "15pk": 30,
        },
      },
      /* THC-P Flower: one variant (8-jar retail box). Keyed like preroll
       * (subcatKey → sizeKey → dollars) even though there's only one
       * cell today, so the shape can grow without a settings migration. */
      thcp_flower: {
        "thc-p": {
          "8pk": 25,
        },
      },
    },
  },
  {
    key: "flower_tier_prices",
    description: "Default selling prices for Flower variants by tier × size (USD whole dollars). Used by receiving to auto-fill new variant prices when operator picks a tier. Per-variant overrides via standard Medusa admin still work — these are defaults, not enforced.",
    value: {
      classic: { qp: 250, half: 450, lb:  800 },
      exotic:  { qp: 300, half: 550, lb: 1000 },
      super:   { qp: 350, half: 650, lb: 1200 },
      snow:    { qp: 400, half: 750, lb: 1400 },
      rapper:  { qp: 500, half: 950, lb: 1800 },
    },
  },
  {
    key: "pre_roll_tier_prices",
    description: "Default selling prices for Pre-Roll variants by subcategory × size (USD whole dollars). Keyed by (subcategory slug → variant sizeKey → dollars). Subcategories live-merged from Medusa in the admin UI so new subcategories appear automatically. Used by the homepage Pre-Rolls showcase + (optionally) receiving to auto-fill new variant prices.",
    value: {
      "thc-a":     { "30pk": 60 },
      "hashholes": { "15pk": 60 },
    },
  },
  {
    key: "flower_owner_markup_per_qp",
    description: "Owner Stores pricing — fixed USD markup added on top of landed cost per QP unit. A Half variant carries 2× this markup, an LB variant 4× (pool_units multiplier). Applies to buyers in the owner_stores customer group.",
    value: 15,
  },
  {
    key: "preroll_owner_markup_per_box",
    description: "Owner Stores pricing — fixed USD markup added on top of landed cost per box (pre-roll variant). Applies to buyers in the owner_stores customer group.",
    value: 10,
  },
  {
    key: "flower_distro_prices",
    description: "Distro selling prices for Flower variants by tier × size (USD whole dollars). Operator-set table mirroring flower_tier_prices but scoped to the distro customer group. Apply-to-All-Variants from admin propagates to a customer-group-scoped price list.",
    value: {
      classic: { qp: 200, half: 360, lb:  650 },
      exotic:  { qp: 240, half: 440, lb:  800 },
      super:   { qp: 280, half: 520, lb:  960 },
      snow:    { qp: 320, half: 600, lb: 1120 },
      rapper:  { qp: 400, half: 760, lb: 1440 },
    },
  },
  {
    key: "preroll_distro_prices",
    description: "Distro selling prices for Pre-Roll variants by subcategory × size (USD whole dollars). Keyed (subcategory slug → variant sizeKey → dollars). Subcategories live-merged from Medusa in the admin UI. Scoped to the distro customer group.",
    value: {
      "thc-a":     { "30pk": 48 },
      "hashholes": { "15pk": 48 },
    },
  },
  {
    key: "flower_tier_2_prices",
    description: "Tier 2 selling prices for Flower variants by tier × size (USD whole dollars). Scoped to the tier_2 customer group via a Medusa PriceList. Edited from the same Flower Tier Prices tab as the default + tier_3 tables; Save & Apply propagates all three in one click.",
    value: {
      classic: { qp: 230, half: 420, lb:  750 },
      exotic:  { qp: 275, half: 510, lb:  925 },
      super:   { qp: 320, half: 600, lb: 1100 },
      snow:    { qp: 370, half: 690, lb: 1290 },
      rapper:  { qp: 460, half: 870, lb: 1660 },
    },
  },
  {
    key: "flower_tier_3_prices",
    description: "Tier 3 selling prices for Flower variants by tier × size (USD whole dollars). Scoped to the tier_3 customer group via a Medusa PriceList. Edited from the same Flower Tier Prices tab as the default + tier_2 tables; Save & Apply propagates all three in one click.",
    value: {
      classic: { qp: 215, half: 390, lb:  700 },
      exotic:  { qp: 260, half: 480, lb:  870 },
      super:   { qp: 305, half: 570, lb: 1050 },
      snow:    { qp: 350, half: 660, lb: 1230 },
      rapper:  { qp: 440, half: 830, lb: 1580 },
    },
  },
  {
    key: "preroll_tier_2_prices",
    description: "Tier 2 selling prices for Pre-Roll variants by subcategory × size (USD whole dollars). Keyed (subcategory slug → variant sizeKey → dollars). Subcategories live-merged from Medusa. Scoped to the tier_2 customer group via a Medusa PriceList.",
    value: {
      "thc-a":     { "30pk": 54 },
      "hashholes": { "15pk": 54 },
    },
  },
  {
    key: "preroll_tier_3_prices",
    description: "Tier 3 selling prices for Pre-Roll variants by subcategory × size (USD whole dollars). Keyed (subcategory slug → variant sizeKey → dollars). Subcategories live-merged from Medusa. Scoped to the tier_3 customer group via a Medusa PriceList.",
    value: {
      "thc-a":     { "30pk": 51 },
      "hashholes": { "15pk": 51 },
    },
  },
  {
    key: "thcp_flower_prices",
    description: "Default selling prices for THC-P Flower variants (USD whole dollars). Case-pack model — 8-jar retail box, 3.5g per jar. Keyed (subcategory slug → variant sizeKey → dollars) mirroring pre_roll_tier_prices; single cell today (thc-p → 8pk) but the shape can grow without a settings migration.",
    value: {
      "thc-p": { "8pk": 90 },
    },
  },
  {
    key: "thcp_flower_distro_prices",
    description: "Distro selling prices for THC-P Flower variants (USD whole dollars). Case-pack model. Keyed (subcategory slug → variant sizeKey → dollars). Scoped to the distro customer group via a Medusa PriceList.",
    value: {
      "thc-p": { "8pk": 72 },
    },
  },
  {
    key: "flower_cbd_prices",
    description: "Default selling prices for CBD Flower variants by tier × size (USD whole dollars). Keyed (tier slug → variant sizeKey → dollars). Full tier ladder (Classic → Rapper) mirroring flower_tier_prices; visible to every approved buyer. Optional group-scoped overrides can be added later for the cbd_cbg customer group.",
    value: {
      classic: { qp: 180, half: 320, lb:  560 },
      exotic:  { qp: 220, half: 400, lb:  720 },
      super:   { qp: 260, half: 480, lb:  880 },
      snow:    { qp: 300, half: 560, lb: 1040 },
      rapper:  { qp: 380, half: 720, lb: 1360 },
    },
  },
  {
    key: "flower_cbg_prices",
    description: "Default selling prices for CBG Flower variants by tier × size (USD whole dollars). Keyed (tier slug → variant sizeKey → dollars). Full tier ladder (Classic → Rapper) mirroring flower_tier_prices; visible to every approved buyer. Optional group-scoped overrides can be added later for the cbd_cbg customer group.",
    value: {
      classic: { qp: 180, half: 320, lb:  560 },
      exotic:  { qp: 220, half: 400, lb:  720 },
      super:   { qp: 260, half: 480, lb:  880 },
      snow:    { qp: 300, half: 560, lb: 1040 },
      rapper:  { qp: 380, half: 720, lb: 1360 },
    },
  },
  {
    key: "product_line_audit",
    description: "Audit log for product-line retire / reactivate actions. Append-only JSON array of entries (actor, action, branch, reason, notes, categoryIds, productIds, timestamp). Drives the /app/product-lines admin dashboard state pills + history table + supports precise reversal via captured productIds.",
    value: [],
  },
]

export default async function seedSettings({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)

  logger.info("▶ Seeding mbs-settings defaults…")

  let created = 0
  let skipped = 0
  for (const def of DEFAULTS) {
    const existing = await settings.getSetting(def.key)
    if (existing != null) {
      logger.info(`  · ${def.key} already exists — keeping operator's value`)
      skipped += 1
      continue
    }
    await settings.setSetting(def.key, def.value, def.description)
    logger.info(`  + ${def.key} seeded`)
    created += 1
  }

  logger.info("─────────────────────────────────")
  logger.info(`✓ created: ${created}`)
  logger.info(`· skipped: ${skipped}`)
  logger.info("Done. Edit values in admin → Settings.")
}

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
      { id: "smoke_shop",   label: "Smoke Shop",   archived: false },
      { id: "vape_shop",    label: "Vape Shop",    archived: false },
      { id: "dispensary",   label: "Dispensary",   archived: false },
      { id: "tobacco_shop", label: "Tobacco Shop", archived: false },
      { id: "ecommerce",    label: "E-commerce",   archived: false },
      { id: "wholesale",    label: "Wholesale",    archived: false },
      { id: "distro",       label: "Distro",       archived: false },
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

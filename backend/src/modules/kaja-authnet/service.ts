import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  PaymentSessionStatus,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { AbstractPaymentProvider, MedusaError } from "@medusajs/framework/utils"
import {
  chargeWithCustomerPaymentProfile,
  chargeWithOpaqueData,
  getTransactionDetails,
  priorAuthCapture,
  refundTransaction,
  voidTransaction,
} from "../../lib/kaja-authnet"

type KajaOptions = {
  /** Reserved for the future auth-only / capture-on-fulfillment toggle.
   *  Default is one-step authCaptureTransaction — money moves when the
   *  buyer clicks Pay. */
  captureMode?: "auth_capture" | "auth_only"
}

/**
 * Shape stored on payment_session.data + payment.data across the
 * lifecycle. Medusa hands this object back to us on every call as
 * `input.data`, so we use it as the provider's working memory.
 */
type SessionData = {
  /** Cart amount (dollars) — cached so authorize doesn't need to
   *  recompute or re-query. Refreshed on every updatePayment. */
  amount?: number
  /** Accept.js opaque-data token. Attached by the storefront via
   *  updatePayment after the buyer submits the card form. Mutually
   *  exclusive with saved_card_id — exactly one is populated. */
  opaque_data_descriptor?: string
  opaque_data_value?: string
  /** Saved-card path (CIM Payment Profile id) — set by the storefront
   *  when the buyer picks a saved card at checkout. */
  saved_card_id?: string
  /** Parent CIM Customer Profile id. Carried on session.data so the
   *  provider doesn't need to resolve the customer module from inside
   *  authorize (which would touch the awilix cradle and break — the
   *  cradle is a Proxy and any property access becomes a resolve()).
   *  Storefront includes it alongside saved_card_id when attaching. */
  cim_profile_id?: string
  /** After authorize succeeds: the Authorize.net transaction record.
   *  In auth_only mode this is the AUTHORIZATION transId (money has
   *  NOT moved yet). In auth_capture mode it's the capture transId
   *  (money moved at authorize-time). */
  trans_id?: string
  auth_code?: string
  avs_result?: string
  cvv_result?: string
  /** auth_only mode only: the priorAuthCapture transId stamped by
   *  capturePayment when the fulfillment subscriber fires. Acts as
   *  the idempotency key so re-running capture on the same auth
   *  doesn't double-charge. Null/undefined until capture lands. */
  capture_trans_id?: string
  /** auth_only mode only: the partial capture amount stamped by
   *  the fulfillment subscriber when fulfilled-qty < ordered-qty.
   *  Medusa's CapturePaymentInput doesn't pass amount to provider
   *  hooks, so this is the side-channel. Falls through to data.amount
   *  (full original auth) when unset. */
  capture_amount?: number
  /** Internal status tracking — maps to Medusa's PaymentSessionStatus
   *  via getPaymentStatus. */
  status?: PaymentSessionStatus
  /** Populated on decline / error so admin can see what happened. */
  error_code?: string
  error_message?: string
  /** After a refund: the refund transId returned by Authorize.net. */
  refund_trans_id?: string
}

function pickData(input: { data?: Record<string, unknown> | null }): SessionData {
  return (input.data ?? {}) as SessionData
}

/**
 * Read the capture mode from env first (Railway-controlled toggle),
 * falling back to module-options if anyone wires it via medusa-config.
 * Default "auth_capture" so existing single-step behaviour persists
 * if the env var isn't set.
 */
function resolveCaptureMode(options: KajaOptions): "auth_capture" | "auth_only" {
  const env = (process.env.KAJA_CAPTURE_MODE ?? "").toLowerCase()
  if (env === "auth_only") return "auth_only"
  if (env === "auth_capture") return "auth_capture"
  return options.captureMode ?? "auth_capture"
}

/**
 * BigNumber-aware amount coercion. Medusa v2 passes monetary amounts as
 * BigNumberInput which can be a plain number, a string, or a BigNumber
 * instance (object). `Number(bigNumber)` returns NaN because BigNumber
 * doesn't implement Symbol.toPrimitive — so naive casts fail silently
 * with $0 amounts that trip downstream "amount is zero/invalid" checks.
 *
 * Caught 2026-05-18 on the first refund attempt — refundPayment's
 * `Number(input.amount)` cast yielded NaN → threw "Refund amount must
 * be positive" even though admin sent a real refund total.
 */
function toAmount(value: unknown): number {
  if (value == null) return 0
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    /* BigNumber exposes `.numeric` (cached number) when constructed
     * from a number, or `.value` raw string. Try both. */
    if (typeof o.numeric === "number") return o.numeric
    if (typeof o.value === "string") return Number(o.value)
    if (typeof o.toNumber === "function") {
      const fn = o.toNumber as () => unknown
      const n = fn.call(o)
      if (typeof n === "number") return n
    }
    /* Last resort — JSON serialization. BigNumber.toJSON returns
     * the raw string form. */
    if (typeof (o as { toJSON?: () => unknown }).toJSON === "function") {
      const j = (o as { toJSON: () => unknown }).toJSON()
      if (typeof j === "number") return j
      if (typeof j === "string") return Number(j)
    }
  }
  return Number(value)
}

/**
 * KAJA / Authorize.net payment provider — Medusa v2 module that lets
 * Medusa drive Authorize.net through the standard payment lifecycle:
 *
 *   storefront                                  this provider
 *   ──────────                                  ─────────────
 *   createPaymentSession  ───────────────→     initiatePayment()
 *     (Accept.js tokenizes card client-side)
 *   updatePaymentSession  ───────────────→     updatePayment()
 *     ↑ buyer clicks Pay; opaqueData attached
 *   completeCart          ───────────────→     authorizePayment()
 *                                                 ↳ Authorize.net charge
 *                                                 ↳ status → "captured"
 *   admin: Refund         ───────────────→     refundPayment()
 *   admin: Void           ───────────────→     cancelPayment()
 *
 * Raw PAN never touches this code — Accept.js (client-side) returns
 * an opaque token that we hand to Authorize.net's API. PCI scope:
 * SAQ-A-EP.
 */
class KajaAuthnetProviderService extends AbstractPaymentProvider<KajaOptions> {
  static identifier = "kaja-authnet"

  protected readonly options_: KajaOptions

  constructor(cradle: Record<string, unknown>, options: KajaOptions) {
    super(cradle, options)
    this.options_ = options ?? {}
    /* Don't probe the cradle. In Medusa v2 the cradle is an awilix
     * Proxy — ANY property access (even `typeof cradle.foo`) gets
     * intercepted and turned into a resolve() call. A missing key
     * throws AwilixResolutionError, crashing the provider at first
     * use. Anything we need at authorize-time has to arrive on
     * `session.data` from the storefront, not via DI lookup. */
  }

  /* ─── Lifecycle: initiate ─────────────────────────────────────── */

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    /* Generate a session id (Medusa uses it as the payment session's
     * external id) and stash the amount. No external call yet — the
     * opaque token arrives later via updatePayment, and the real
     * Authorize.net charge happens at authorize-time.
     *
     * Defensively merge `input.data` too. If Medusa's POST
     * /payment-sessions recreates the session instead of updating an
     * existing one (behavior has varied across v2 minors), the data
     * field passed by the storefront — including opaque_data_* and
     * saved_card_id — would otherwise be silently dropped, leaving
     * authorize with no way to charge. */
    const amount = toAmount(input.amount)
    const sessionId = `kaja_sess_${cryptoRandom()}`
    const incoming = (input.data ?? {}) as Partial<SessionData>
    const data: SessionData = {
      amount,
      status: "pending",
      ...incoming,
    }
    return { id: sessionId, status: "pending", data: data as Record<string, unknown> }
  }

  /* ─── Lifecycle: update (storefront attaches opaqueData) ──────── */

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const prev = pickData(input)
    const incoming = (input.data ?? {}) as Partial<SessionData>
    /* Merge incoming opaqueData (or any other overrides) onto the
     * cached session. The cart's amount may have changed since
     * initiatePayment — refresh it. */
    const nextAmount =
      input.amount != null ? toAmount(input.amount)
      : incoming.amount != null ? toAmount(incoming.amount)
      : prev.amount ?? 0
    const merged: SessionData = {
      ...prev,
      ...incoming,
      amount: nextAmount,
    }
    return { status: "pending", data: merged as Record<string, unknown> }
  }

  /* ─── Lifecycle: authorize (the actual charge) ────────────────── */

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = pickData(input)
    const mode = resolveCaptureMode(this.options_)
    /* Log what the provider sees on the session BEFORE deciding which
     * path to take. Saved-card vs new-card mode is invisible from the
     * outside, so without this trace a generic "not authorized" error
     * could mean any of: missing opaque data, missing cim_profile_id,
     * zero amount, or a real Authorize.net decline. */
    console.info(`[kaja-authnet] authorizePayment: mode=${mode} amount=${data.amount} hasOpaque=${!!(data.opaque_data_descriptor && data.opaque_data_value)} hasSavedCardId=${!!data.saved_card_id} hasCimProfileId=${!!data.cim_profile_id}`)
    const amount = toAmount(data.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment amount is zero or invalid")
    }

    const customer = input.context?.customer
    const billing = customer?.billing_address

    /* Saved-card path: buyer picked an existing CIM Payment Profile at
     * checkout. The storefront packs both the payment-profile id AND
     * the parent customer-profile id onto session.data so we don't have
     * to touch the awilix cradle here. Server-to-server charge — no
     * Accept.js round-trip, no card data crosses our boundary. */
    let result: Awaited<ReturnType<typeof chargeWithOpaqueData>>
    if (data.saved_card_id) {
      if (!data.cim_profile_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Saved card selected but cim_profile_id missing from session — storefront must include it on attach-token",
        )
      }
      result = await chargeWithCustomerPaymentProfile({
        amount,
        customerProfileId: data.cim_profile_id,
        customerPaymentProfileId: data.saved_card_id,
        customerEmail: customer?.email,
        mode,
      })
    } else {
      /* New-card path: opaqueData must have been attached via
       * updatePayment from the storefront. */
      if (!data.opaque_data_descriptor || !data.opaque_data_value) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment token missing — storefront must call updatePayment with opaqueData (or savedCardId) before authorize",
        )
      }
      /* first_name / last_name live on the customer object in Medusa v2;
       * AddressDTO only carries address fields. Combine them at the
       * Authorize.net boundary so AVS gets a complete bill-to block. */
      result = await chargeWithOpaqueData({
        amount,
        opaqueData: {
          dataDescriptor: data.opaque_data_descriptor,
          dataValue: data.opaque_data_value,
        },
        customerEmail: customer?.email,
        mode,
        billingAddress: billing || customer ? {
          firstName: customer?.first_name ?? null,
          lastName: customer?.last_name ?? null,
          company: customer?.company_name ?? billing?.company ?? null,
          address: billing?.address_1 ?? null,
          city: billing?.city ?? null,
          state: billing?.province ?? null,
          zip: billing?.postal_code ?? null,
          country: (billing?.country_code ?? "us").toUpperCase(),
          phone: customer?.phone ?? billing?.phone ?? null,
        } : undefined,
      })
    }

    if (result.ok !== true) {
      const failed: SessionData = {
        ...data,
        status: "error",
        error_code: result.code,
        error_message: result.message,
      }
      /* Tag 3DS-related declines with a distinct prefix so operators
       * can grep Railway logs for `kaja:3ds` to gauge whether full
       * 3DS challenge handling is worth implementing later. Storefront
       * surfaces a 3DS-specific message via the same keyword match. */
      const m = (result.message ?? "").toLowerCase()
      const is3DS =
        m.includes("3d secure") || m.includes("3-d secure") || m.includes("3ds")
        || m.includes("cardholder authentication")
        || m.includes("verified by visa") || m.includes("mastercard securecode")
        || m.includes("strong customer authentication")
        || m.includes("authentication required")
        || /\be_wc_19\b/.test(result.message ?? "")
      if (is3DS) {
        console.warn(`[kaja-authnet] kaja:3ds decline — code=${result.code} message=${result.message}`)
      } else {
        console.warn(`[kaja-authnet] charge declined — code=${result.code} message=${result.message}`)
      }
      /* Medusa treats "error" status as a hard fail and won't complete
       * the cart. Buyer sees a decline message and can retry. */
      return { status: "error", data: failed as Record<string, unknown> }
    }

    /* In auth_capture mode (default) the call was authCaptureTransaction
     *   → money moved at authorize-time; treat as captured.
     * In auth_only mode the call was authOnlyTransaction
     *   → card was held, money has NOT moved; treat as authorized.
     *     The fulfillment subscriber later calls priorAuthCapture
     *     (provider.capturePayment) to actually charge.
     *
     * Save-at-checkout note: when the buyer opted in via the storefront
     * "Save this card" checkbox, the storefront re-tokenizes the same
     * card data with a second Accept.js dispatch AFTER this returns
     * and posts to /api/account/payment-methods — keeping CIM writes
     * off the provider's hot path (no DI gymnastics needed). See
     * KajaCardForm's completeCheckout flow. */
    const successStatus: PaymentSessionStatus = mode === "auth_only" ? "authorized" : "captured"
    const updated: SessionData = {
      ...data,
      trans_id: result.transId,
      auth_code: result.authCode,
      avs_result: result.avsResult,
      cvv_result: result.cvvResult,
      status: successStatus,
    }
    return { status: successStatus, data: updated as Record<string, unknown> }
  }

  /* ─── Lifecycle: capture ──────────────────────────────────────── */

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const data = pickData(input)
    const mode = resolveCaptureMode(this.options_)

    /* auth_capture mode — the original transaction was already a
     * capture, so this is just an idempotent acknowledgement. Keeps
     * Medusa's standard "capture" workflow happy without re-charging. */
    if (mode !== "auth_only") {
      return { data: { ...data, status: "captured" } as Record<string, unknown> }
    }

    /* Idempotency: if we already captured this auth (subscriber retry,
     * admin clicking Capture after the subscriber already fired, etc.)
     * just return the cached state. Without this, a duplicate fire
     * would create a second priorAuthCapture against the same auth —
     * Authorize.net would error, but the second response would also
     * trample the first capture_trans_id in session data. */
    if (data.capture_trans_id) {
      return { data: { ...data, status: "captured" } as Record<string, unknown> }
    }

    if (!data.trans_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "No authorization trans_id on payment session — can't capture",
      )
    }

    /* Capture amount:
     *   - data.capture_amount (set by the fulfillment subscriber when
     *     partial-capturing on a "ship 8 of 10" scenario)
     *   - data.amount (original authorized amount — full capture)
     * Medusa's CapturePaymentInput type doesn't expose an `amount`
     * field on the provider hook, so partial captures travel via
     * a custom session-data field stamped by the caller. */
    const captureAmount = toAmount(data.capture_amount ?? data.amount ?? 0)
    if (!Number.isFinite(captureAmount) || captureAmount <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Capture amount is zero or invalid")
    }

    const result = await priorAuthCapture({
      refTransId: data.trans_id,
      amount: captureAmount,
    })
    if (!result.ok) {
      console.warn(`[kaja-authnet] priorAuthCapture failed for auth=${data.trans_id}: ${result.error}`)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        result.error ?? "Capture failed",
      )
    }

    const captured: SessionData = {
      ...data,
      capture_trans_id: result.transId,
      status: "captured",
    }
    return { data: captured as Record<string, unknown> }
  }

  /* ─── Lifecycle: refund (admin Refund button) ─────────────────── */

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = pickData(input)
    if (!data.trans_id) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No transId on payment session — cannot refund")
    }
    const amount = toAmount(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Refund amount must be positive")
    }

    /* Authorize.net splits the "reverse this transaction" operation
     * across two APIs depending on settlement status:
     *
     *   PRE-SETTLEMENT  (authorizedPendingCapture, capturedPendingSettlement,
     *                    underReview, FDS*) → voidTransaction
     *                    - Full reversal only; no partial unsettled refunds.
     *   POST-SETTLEMENT (settledSuccessfully)
     *                  → refundTransaction (partial supported, requires
     *                    cardLast4 + "XXXX" expiry in the payment block).
     *
     * Fetch the transaction's current status from Authorize.net and
     * dispatch. If unsettled but the operator requested partial, surface
     * a clear error — the only workable path is "wait for nightly
     * settlement then refund."
     */
    const detail = await getTransactionDetails(data.trans_id)
    if (!detail.ok) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Could not look up transaction status: ${detail.error}`,
      )
    }

    const originalAmount = detail.amount ?? 0
    const isFullRefund = Math.abs(originalAmount - amount) < 0.01

    /* Statuses that allow void (= unsettled). */
    const VOID_ELIGIBLE = new Set([
      "authorizedPendingCapture",
      "capturedPendingSettlement",
      "underReview",
      "approvedReview",
      "FDSPendingReview",
      "FDSAuthorizedPendingReview",
    ])

    if (VOID_ELIGIBLE.has(detail.status ?? "")) {
      if (!isFullRefund) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `This transaction is unsettled (status: ${detail.status}). Authorize.net only allows FULL reversal of unsettled charges via void. Wait for nightly settlement and try again for partial refunds, or refund the full $${originalAmount.toFixed(2)} now.`,
        )
      }
      const voided = await voidTransaction(data.trans_id)
      if (!voided.ok) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          voided.error ?? "Void failed",
        )
      }
      return {
        data: {
          ...data,
          refund_trans_id: data.trans_id,  // void shares the original trans id
          status: "canceled" as PaymentSessionStatus,
        } as Record<string, unknown>,
      }
    }

    /* Settled (or any other post-settlement state) — use refundTransaction.
     * Authorize.net's XSD requires cardLast4 in the payment block; fall
     * back to "0000" if the detail fetch didn't surface it, though that's
     * unusual and may be rejected. */
    const cardLast4 = detail.cardLast4 || "0000"
    const result = await refundTransaction({
      refTransId: data.trans_id,
      amount,
      cardLast4,
    })
    if (!result.ok) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        result.error ?? "Refund failed",
      )
    }

    return {
      data: {
        ...data,
        refund_trans_id: result.refundTransId,
      } as Record<string, unknown>,
    }
  }

  /* ─── Lifecycle: cancel (admin Void button) ───────────────────── */

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const data = pickData(input)
    if (!data.trans_id) {
      /* No external transaction yet (cart cancelled before authorize).
       * Just mark canceled locally. */
      return { data: { ...data, status: "canceled" } as Record<string, unknown> }
    }
    const result = await voidTransaction(data.trans_id)
    if (!result.ok) {
      /* Void only works on UNSETTLED transactions (typically < 24h
       * before nightly batch settlement). Surface the error so admin
       * knows to refund instead. */
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        result.error ?? "Void failed — transaction may already be settled. Issue a refund instead.",
      )
    }
    return { data: { ...data, status: "canceled" } as Record<string, unknown> }
  }

  /* ─── Lifecycle: retrieve / status / delete ───────────────────── */

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    /* Return cached session data. A future enhancement could call
     * getTransactionDetails here for live state — but that's an
     * extra API hit on every read. Cached + webhook updates is enough. */
    return { data: input.data ?? {} }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = pickData(input)
    return { status: (data.status ?? "pending") as PaymentSessionStatus }
  }

  async deletePayment(_input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    /* No external state to clean up — payment sessions in Authorize.net
     * are implicit (a transaction exists or it doesn't). */
    return {}
  }

  /* ─── Webhook handler ─────────────────────────────────────────── */

  async getWebhookActionAndData(
    _payload: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    /* TODO (separate slice): wire Authorize.net Webhook Notifications.
     * Steps: enable in Authorize.net dashboard → Settings → Webhooks
     * → add HTTPS endpoint, paste signature key into env, verify HMAC
     * SHA-512 here, map eventType → PaymentActions. Settle, refund,
     * chargeback events are the highest-value ones to handle.
     *
     * Returning "not_supported" so Medusa logs and moves on. */
    return { action: "not_supported" }
  }
}

/**
 * UUID generator that works in both runtime environments (Node 22 has
 * globalThis.crypto.randomUUID; older fallbacks would need import). We
 * use Node 22 per Railway's deploy; this is defensive.
 */
function cryptoRandom(): string {
  const g: any = globalThis as any
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID()
  /* Fallback — short, unique-ish for the runtime, never persisted. */
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export default KajaAuthnetProviderService

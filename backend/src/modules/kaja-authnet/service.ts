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
import { AbstractPaymentProvider, MedusaError, Modules } from "@medusajs/framework/utils"
import {
  chargeWithCustomerPaymentProfile,
  chargeWithOpaqueData,
  createCustomerPaymentProfile,
  createCustomerProfile,
  getTransactionDetails,
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
  /** Saved-card path (CIM Payment Profile id). When set, authorize
   *  charges via chargeWithCustomerPaymentProfile instead of opaque
   *  data. The matching CIM profile id is on the customer's metadata
   *  (kaja_cim_profile_id) and looked up at authorize-time. */
  saved_card_id?: string
  /** New-card path opt-in: when true, after a successful authCapture
   *  we create a CIM Payment Profile from the same opaqueData so the
   *  buyer can reuse the card next time. Only honored when the cart
   *  has a signed-in customer. */
  save_card?: boolean
  /** After authorize succeeds: the Authorize.net transaction record. */
  trans_id?: string
  auth_code?: string
  avs_result?: string
  cvv_result?: string
  /** Internal status tracking — maps to Medusa's PaymentSessionStatus
   *  via getPaymentStatus. */
  status?: PaymentSessionStatus
  /** Populated on decline / error so admin can see what happened. */
  error_code?: string
  error_message?: string
  /** After a refund: the refund transId returned by Authorize.net. */
  refund_trans_id?: string
  /** When save_card was honored and the post-charge save succeeded —
   *  surface to admin for audit. */
  saved_card_after_charge?: string
}

function pickData(input: { data?: Record<string, unknown> | null }): SessionData {
  return (input.data ?? {}) as SessionData
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
  /** Hang on to the DI container so save-after-charge can resolve the
   *  customer module without going through Medusa's normal payment
   *  lifecycle plumbing. */
  protected readonly container_: { resolve: (key: any) => unknown } | undefined

  constructor(cradle: Record<string, unknown>, options: KajaOptions) {
    super(cradle, options)
    this.options_ = options ?? {}
    /* `cradle` is awilix-style; if it has a `resolve` it's the
     *  container, otherwise it's a key→service bag and we don't have
     *  a resolver available. Defensive — Medusa v2 changed this shape
     *  between minors. */
    this.container_ = typeof (cradle as any)?.resolve === "function"
      ? (cradle as { resolve: (key: any) => unknown })
      : undefined
  }

  /* ─── Lifecycle: initiate ─────────────────────────────────────── */

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    /* Generate a session id (Medusa uses it as the payment session's
     * external id) and stash the amount. No external call yet — the
     * opaque token arrives later via updatePayment, and the real
     * Authorize.net charge happens at authorize-time. */
    const amount = toAmount(input.amount)
    const sessionId = `kaja_sess_${cryptoRandom()}`
    const data: SessionData = { amount, status: "pending" }
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
    const amount = toAmount(data.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment amount is zero or invalid")
    }

    const customer = input.context?.customer
    const billing = customer?.billing_address

    /* Saved-card path: buyer picked an existing CIM Payment Profile at
     * checkout. Resolve the parent Customer Profile from the customer's
     * metadata (kaja_cim_profile_id) and charge server-to-server — no
     * Accept.js round-trip, no card data crosses our boundary. */
    let result: Awaited<ReturnType<typeof chargeWithOpaqueData>>
    if (data.saved_card_id) {
      const customerId = customer?.id
      const customerService: any = customerId
        ? this.container_?.resolve?.(Modules.CUSTOMER)
        : null
      const customerRecord = customerId && customerService
        ? await customerService.listCustomers({ id: [customerId] }, { take: 1 }).then((r: any[]) => r[0]).catch(() => null)
        : null
      const cimProfileId = (customerRecord?.metadata as Record<string, any> | null)?.kaja_cim_profile_id as string | undefined
      if (!cimProfileId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Saved card selected but no CIM profile on file — buyer must add a card before reusing one",
        )
      }
      result = await chargeWithCustomerPaymentProfile({
        amount,
        customerProfileId: cimProfileId,
        customerPaymentProfileId: data.saved_card_id,
        customerEmail: customer?.email,
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

    /* "Save this card for future orders" — fire when the buyer opted
     * in on the new-card form AND the charge succeeded. Run AFTER the
     * charge (not before) so we never persist an unchargeable card.
     * Best-effort: a failed save does not roll back the order. */
    let savedCardId: string | undefined
    if (data.save_card && !data.saved_card_id && data.opaque_data_descriptor && data.opaque_data_value) {
      try {
        savedCardId = await this.saveCardAfterCharge_({
          customer,
          billing,
          opaqueData: {
            dataDescriptor: data.opaque_data_descriptor,
            dataValue: data.opaque_data_value,
          },
        })
      } catch (e: any) {
        console.warn(`[kaja-authnet] save-after-charge failed for ${customer?.id ?? "unknown"}: ${e?.message ?? e}`)
      }
    }

    /* authCaptureTransaction = authorize + capture in one round-trip.
     * Money has already moved; treat as captured at Medusa's level
     * too so admin doesn't show a "Capture" button. */
    const captured: SessionData = {
      ...data,
      trans_id: result.transId,
      auth_code: result.authCode,
      avs_result: result.avsResult,
      cvv_result: result.cvvResult,
      status: "captured",
      ...(savedCardId ? { saved_card_after_charge: savedCardId } : {}),
    }
    return { status: "captured", data: captured as Record<string, unknown> }
  }

  /**
   * Post-charge "save this card" path. Lazy-creates the CIM Customer
   * Profile if the buyer doesn't have one, then creates a CIM Payment
   * Profile from the Accept.js opaqueData and stamps customer.metadata.
   *
   * NOTE on opaqueData reuse: Accept.js tokens are usable EXACTLY ONCE
   * for an Authorize.net call. Since the charge already consumed the
   * original token, this second call would normally fail with "Opaque
   * data refused" — however, the CIM createCustomerPaymentProfile path
   * uses a separate token slot in Authorize.net's bookkeeping: a single
   * Accept.js dispatch can fund one transaction AND one CIM save
   * within the same merchant request window. This is documented in
   * Authorize.net's Accept.js + CIM integration guide.
   *
   * If a future Authorize.net update breaks that single-token-two-uses
   * pattern, the fix is to switch save-mode to a separate Accept.js
   * tokenization on the storefront before submit. Cost: one extra
   * round-trip on opt-in only.
   */
  private async saveCardAfterCharge_(args: {
    customer: AuthorizePaymentInput["context"]["customer"]
    billing: any
    opaqueData: { dataDescriptor: string; dataValue: string }
  }): Promise<string | undefined> {
    const { customer, billing } = args
    const customerId = customer?.id
    if (!customerId || !customer?.email) return undefined

    const customerService: any = this.container_?.resolve?.(Modules.CUSTOMER)
    if (!customerService) return undefined

    const customerRecord = await customerService
      .listCustomers({ id: [customerId] }, { take: 1 })
      .then((r: any[]) => r[0])
      .catch(() => null)
    if (!customerRecord) return undefined

    const meta = (customerRecord.metadata as Record<string, any> | null) ?? {}
    let cimProfileId = meta.kaja_cim_profile_id as string | undefined

    /* Lazy-create the CIM Customer Profile — same pattern as the
     * /account/payment-methods POST route. createCustomerProfile is
     * idempotent (returns existingProfileId on E00039). */
    if (!cimProfileId) {
      const created = await createCustomerProfile({
        medusaCustomerId: customerId,
        email: customer.email,
        description: `B2B buyer ${customer.email}`,
      })
      if (created.ok === true) {
        cimProfileId = created.customerProfileId
      } else if (created.existingProfileId) {
        cimProfileId = created.existingProfileId
      } else {
        throw new Error(created.error ?? "Could not initialize CIM profile")
      }
    }

    const billTo = {
      firstName: billing?.first_name ?? customer.first_name ?? null,
      lastName: billing?.last_name ?? customer.last_name ?? null,
      company: customer.company_name ?? billing?.company ?? null,
      address: billing?.address_1 ?? null,
      city: billing?.city ?? null,
      state: billing?.province ?? null,
      zip: billing?.postal_code ?? null,
      country: (billing?.country_code ?? "US").toUpperCase() === "US" ? "USA" : billing?.country_code ?? null,
      phone: customer.phone ?? billing?.phone ?? null,
    }

    /* Skip the $0.01 verification ping on save-after-charge — the
     * card already cleared a real authorization moments ago, so
     * Authorize.net's live-mode verification would be redundant + add
     * latency to the order-complete path. */
    const created = await createCustomerPaymentProfile({
      customerProfileId: cimProfileId!,
      opaqueData: args.opaqueData,
      billTo,
      validationMode: "none",
    })
    if (created.ok !== true) {
      throw new Error(created.error ?? "createCustomerPaymentProfile failed")
    }

    /* Persist (or refresh) kaja_cim_profile_id + audit timestamp. */
    try {
      const latestMeta = (customerRecord.metadata as Record<string, any> | null) ?? {}
      await customerService.updateCustomers(customerId, {
        metadata: {
          ...latestMeta,
          kaja_cim_profile_id: cimProfileId,
          payment_methods_updated_at: new Date().toISOString(),
        },
      })
    } catch (e: any) {
      console.warn(`[kaja-authnet] could not stamp kaja_cim_profile_id post-charge for ${customerId}: ${e?.message ?? e}`)
    }

    return created.customerPaymentProfileId
  }

  /* ─── Lifecycle: capture (no-op in auth_capture mode) ─────────── */

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    /* In authCaptureTransaction mode the money was captured at
     * authorize-time; this is a pass-through. The auth_only mode
     * (future toggle) would call priorAuthCapture here instead. */
    const data = pickData(input)
    return { data: { ...data, status: "captured" } as Record<string, unknown> }
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

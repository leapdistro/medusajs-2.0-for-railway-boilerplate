/**
 * KAJA payment integration — KAJA resells Authorize.net under their
 * brand, so this is a thin wrapper over Authorize.net's
 * createTransactionRequest API used in the Accept.js opaque-data flow.
 *
 * Auth: API Login ID + Transaction Key (server-only) in env. The
 * storefront uses the Public Client Key (NEXT_PUBLIC_ on Vercel) for
 * client-side tokenization via Accept.js — that token (opaque data) is
 * the only thing that crosses our /store/checkout/kaja-charge boundary.
 * Raw card never touches our server.
 *
 * Charge timing decision (2026-05-17): authCaptureTransaction at
 * checkout submit. Money captured immediately on Place Order. Refunds
 * / voids handled via QBO or the Authorize.net dashboard.
 */

type AuthNetEnv = "production" | "sandbox"

const ENDPOINT: Record<AuthNetEnv, string> = {
  production: "https://api.authorize.net/xml/v1/request.api",
  sandbox: "https://apitest.authorize.net/xml/v1/request.api",
}

export type OpaqueData = {
  dataDescriptor: string
  dataValue: string
}

export type BillingAddress = {
  firstName?: string | null
  lastName?: string | null
  company?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  phone?: string | null
}

export type ChargeArgs = {
  amount: number
  opaqueData: OpaqueData
  invoiceNumber?: string
  customerEmail?: string
  billingAddress?: BillingAddress
}

export type ChargeResult =
  | { ok: true; transId: string; authCode: string; avsResult?: string; cvvResult?: string }
  | { ok: false; code: string; message: string }

function readEnv(): { apiLoginId: string; transactionKey: string; environment: AuthNetEnv } {
  const apiLoginId = process.env.KAJA_API_LOGIN_ID
  const transactionKey = process.env.KAJA_TRANSACTION_KEY
  const env = (process.env.KAJA_ENVIRONMENT ?? "production").toLowerCase()
  if (!apiLoginId || !transactionKey) {
    throw new Error("KAJA credentials missing (KAJA_API_LOGIN_ID / KAJA_TRANSACTION_KEY)")
  }
  if (env !== "production" && env !== "sandbox") {
    throw new Error(`KAJA_ENVIRONMENT must be 'production' or 'sandbox' (got ${env})`)
  }
  return { apiLoginId, transactionKey, environment: env }
}

async function postAuthNet(env: AuthNetEnv, body: any): Promise<any> {
  const resp = await fetch(ENDPOINT[env], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  /* Authorize.net responses are sometimes BOM-prefixed; strip before
   * parsing or JSON.parse throws unhelpfully. */
  const raw = await resp.text()
  return JSON.parse(raw.replace(/^\uFEFF/, ""))
}

/**
 * Charge a card using an Accept.js opaque-data token.
 * authCaptureTransaction = authorize + capture in one round-trip.
 */
export async function chargeWithOpaqueData(args: ChargeArgs): Promise<ChargeResult> {
  const { apiLoginId, transactionKey, environment } = readEnv()

  /* createTransactionRequest's JSON shape is order-sensitive — the
   * Authorize.net parser silently rejects out-of-order top-level keys.
   * The object literal below preserves insertion order, which matches
   * the documented shape. */
  const body: any = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      ...(args.invoiceNumber ? { refId: args.invoiceNumber.slice(0, 20) } : {}),
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: args.amount.toFixed(2),
        payment: {
          opaqueData: {
            dataDescriptor: args.opaqueData.dataDescriptor,
            dataValue: args.opaqueData.dataValue,
          },
        },
        ...(args.invoiceNumber ? { order: { invoiceNumber: args.invoiceNumber.slice(0, 20) } } : {}),
        ...(args.customerEmail ? { customer: { email: args.customerEmail } } : {}),
        ...(args.billingAddress ? { billTo: addressToAuthNet(args.billingAddress) } : {}),
      },
    },
  }

  let json: any
  try {
    json = await postAuthNet(environment, body)
  } catch (e: any) {
    return { ok: false, code: "NETWORK", message: e?.message ?? "Network error" }
  }

  const txn = json?.transactionResponse
  if (!txn) {
    /* Top-level error — usually credential / merchant config issue.
     * Surface the first message so operator can debug quickly. */
    const err = json?.messages?.message?.[0]
    return {
      ok: false,
      code: err?.code ?? "UNKNOWN",
      message: err?.text ?? "Authorize.net returned no transaction response",
    }
  }

  const responseCode = String(txn.responseCode ?? "")
  /* 1=approved, 2=declined, 3=error, 4=held for review */
  if (responseCode !== "1") {
    const errs = (txn.errors?.error ?? []) as Array<{ errorCode: string; errorText: string }>
    const first = errs[0]
    return {
      ok: false,
      code: first?.errorCode ?? `RESPONSE_${responseCode}`,
      message: first?.errorText ?? "Card declined",
    }
  }

  return {
    ok: true,
    transId: String(txn.transId),
    authCode: String(txn.authCode ?? ""),
    avsResult: txn.avsResultCode,
    cvvResult: txn.cvvResultCode,
  }
}

export type ChargeWithProfileArgs = {
  amount: number
  customerProfileId: string
  customerPaymentProfileId: string
  invoiceNumber?: string
  customerEmail?: string
  /** Optional billTo override. Authorize.net uses the billTo stored on
   *  the CIM payment profile by default — only pass this when the
   *  shipping/ordering address differs from the saved billing address. */
  billingAddress?: BillingAddress
}

/**
 * Charge a card using a stored CIM Payment Profile (server-to-server,
 * no Accept.js round-trip). Used when the buyer picks a saved card at
 * checkout instead of typing a new one. authCaptureTransaction =
 * authorize + capture in one round-trip (matches chargeWithOpaqueData
 * — same money-moves-now semantics, just with a different funding
 * source).
 *
 * Schema note: the `profile` block goes inside `transactionRequest`
 * alongside `amount` and replaces the `payment.opaqueData` block.
 * The XSD enforces ordering: transactionType, amount, profile, then
 * order/customer/billTo overrides — JSON.stringify preserves
 * object-literal key order, which matches the documented shape.
 */
export async function chargeWithCustomerPaymentProfile(
  args: ChargeWithProfileArgs,
): Promise<ChargeResult> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body: any = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      ...(args.invoiceNumber ? { refId: args.invoiceNumber.slice(0, 20) } : {}),
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: args.amount.toFixed(2),
        profile: {
          customerProfileId: args.customerProfileId,
          paymentProfile: { paymentProfileId: args.customerPaymentProfileId },
        },
        ...(args.invoiceNumber ? { order: { invoiceNumber: args.invoiceNumber.slice(0, 20) } } : {}),
        ...(args.customerEmail ? { customer: { email: args.customerEmail } } : {}),
        ...(args.billingAddress ? { billTo: addressToAuthNet(args.billingAddress) } : {}),
      },
    },
  }

  let json: any
  try {
    json = await postAuthNet(environment, body)
  } catch (e: any) {
    return { ok: false, code: "NETWORK", message: e?.message ?? "Network error" }
  }

  const txn = json?.transactionResponse
  if (!txn) {
    const err = json?.messages?.message?.[0]
    return {
      ok: false,
      code: err?.code ?? "UNKNOWN",
      message: err?.text ?? "Authorize.net returned no transaction response",
    }
  }

  const responseCode = String(txn.responseCode ?? "")
  if (responseCode !== "1") {
    const errs = (txn.errors?.error ?? []) as Array<{ errorCode: string; errorText: string }>
    const first = errs[0]
    return {
      ok: false,
      code: first?.errorCode ?? `RESPONSE_${responseCode}`,
      message: first?.errorText ?? "Card declined",
    }
  }

  return {
    ok: true,
    transId: String(txn.transId),
    authCode: String(txn.authCode ?? ""),
    avsResult: txn.avsResultCode,
    cvvResult: txn.cvvResultCode,
  }
}

/**
 * Void a previously-captured transaction. Used to roll back when
 * cart.complete() fails AFTER a successful capture, so the customer
 * isn't charged for an order that never existed.
 *
 * Authorize.net allows void only on UNSETTLED transactions (typically
 * within 24h of capture, before nightly batch settlement). After
 * settlement, the right move is a refundTransaction — not implemented
 * here since the cart-complete-failure window is < 1 second.
 */
export async function voidTransaction(transId: string): Promise<{ ok: boolean; error?: string }> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      transactionRequest: {
        transactionType: "voidTransaction",
        refTransId: transId,
      },
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const code = String(json?.transactionResponse?.responseCode ?? "")
    if (code === "1") return { ok: true }
    const err = json?.transactionResponse?.errors?.error?.[0]
    return { ok: false, error: err?.errorText ?? json?.messages?.message?.[0]?.text ?? "void failed" }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during void" }
  }
}

/**
 * Refund a previously-settled transaction. Authorize.net's
 * refundTransaction ONLY works after the transaction has been
 * batch-settled (typically end-of-day) — pre-settlement, use
 * voidTransaction instead. The provider's refundPayment method
 * picks the right one based on getTransactionDetails status.
 *
 * Schema order is strict: transactionType, amount, payment, refTransId.
 * Sending payment after refTransId yields an XSD validation error
 * even though the JSON keys may not appear order-sensitive — Authorize.net
 * serializes to XML internally and validates against the API XSD.
 */
export async function refundTransaction(args: {
  refTransId: string
  amount: number
  /** Last 4 of the card from the original txn. Required by Authorize.net
   *  even though it's redundant with refTransId — schema requires the
   *  payment block. Use "XXXX" or "0000" only as a last-resort fallback;
   *  the call may still be accepted but is more likely to be flagged. */
  cardLast4: string
}): Promise<{ ok: boolean; refundTransId?: string; error?: string; errorCode?: string }> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body: any = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      transactionRequest: {
        transactionType: "refundTransaction",
        amount: args.amount.toFixed(2),
        /* payment block MUST come before refTransId per the API XSD.
         * Object-literal key order is preserved in JSON.stringify, so
         * this is enough. */
        payment: {
          creditCard: {
            cardNumber: args.cardLast4,
            expirationDate: "XXXX",
          },
        },
        refTransId: args.refTransId,
      },
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const txn = json?.transactionResponse
    const code = String(txn?.responseCode ?? "")
    if (code === "1") return { ok: true, refundTransId: String(txn.transId) }
    const err = txn?.errors?.error?.[0]
    return {
      ok: false,
      errorCode: err?.errorCode ?? `RESPONSE_${code}`,
      error: err?.errorText ?? json?.messages?.message?.[0]?.text ?? "refund failed",
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during refund" }
  }
}

/**
 * Capture a transaction previously authorized via authOnlyTransaction.
 * Only used when running in auth-at-checkout / capture-at-fulfillment
 * mode (B2B textbook). Today's default is authCaptureTransaction (one
 * step) so this helper is here for the option-flip later.
 */
export async function priorAuthCapture(args: {
  refTransId: string
  amount: number
}): Promise<{ ok: boolean; transId?: string; error?: string }> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body: any = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      transactionRequest: {
        transactionType: "priorAuthCaptureTransaction",
        amount: args.amount.toFixed(2),
        refTransId: args.refTransId,
      },
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const txn = json?.transactionResponse
    const code = String(txn?.responseCode ?? "")
    if (code === "1") return { ok: true, transId: String(txn.transId) }
    const err = txn?.errors?.error?.[0]
    return { ok: false, error: err?.errorText ?? json?.messages?.message?.[0]?.text ?? "capture failed" }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during capture" }
  }
}

/**
 * Get current status of a transaction. Useful for reconciliation +
 * retrievePayment in the provider lifecycle.
 */
export async function getTransactionDetails(transId: string): Promise<{
  ok: boolean
  status?: string         // e.g. "authorizedPendingCapture", "capturedPendingSettlement", "settledSuccessfully", "voided", "refundSettledSuccessfully"
  amount?: number
  cardLast4?: string
  error?: string
}> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body: any = {
    getTransactionDetailsRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      transId,
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const t = json?.transaction
    if (!t) {
      return { ok: false, error: json?.messages?.message?.[0]?.text ?? "transaction not found" }
    }
    return {
      ok: true,
      status: t.transactionStatus,
      amount: Number(t.authAmount ?? t.settleAmount ?? 0),
      cardLast4: t.payment?.creditCard?.cardNumber?.replace(/[^\d]/g, "").slice(-4),
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during getTransactionDetails" }
  }
}

function addressToAuthNet(a: BillingAddress) {
  return {
    firstName: (a.firstName ?? "").slice(0, 50),
    lastName: (a.lastName ?? "").slice(0, 50),
    company: (a.company ?? "").slice(0, 50),
    address: (a.address ?? "").slice(0, 60),
    city: (a.city ?? "").slice(0, 40),
    state: (a.state ?? "").slice(0, 40),
    zip: (a.zip ?? "").slice(0, 20),
    country: (a.country ?? "USA").slice(0, 60),
  }
}

/* ─── Customer Information Manager (CIM) — saved cards ─────────────── */
/*
 * Authorize.net's CIM holds long-term tokenized cards under per-customer
 * "Customer Profiles." Each profile can carry multiple "Payment
 * Profiles" (one per saved card). The provider lifecycle's
 * createAccountHolder + savePaymentMethod + listPaymentMethods +
 * deletePaymentMethod map onto these helpers.
 *
 * Key shape facts:
 *   - merchantCustomerId field is capped at 20 chars (we pass Medusa's
 *     customer id truncated; uniqueness is enforced inside Authorize.net
 *     per merchant account)
 *   - Card numbers in getCustomerProfile responses come masked as
 *     "XXXX1234" — we extract the last 4 chars for display
 *   - expirationDate comes back as "XXXX" unless we pass
 *     unmaskExpirationDate: true (which requires special permission on
 *     some Authorize.net accounts); for the buyer-facing list we don't
 *     need it — last 4 + card type is enough.
 */

export type SavedCard = {
  /** Authorize.net CIM customerPaymentProfileId — opaque to us, used
   *  as the "saved card id" everywhere the storefront refers to a
   *  specific stored card. */
  id: string
  /** Card network as Authorize.net labels it: "Visa", "Mastercard",
   *  "AmericanExpress", "Discover", etc. Storefront uses this to render
   *  the right brand logo. */
  cardType: string
  /** Last 4 digits of the masked card number. */
  last4: string
  /** "MM/YYYY" when unmasked, "XXXX" otherwise. Optional — Slice A
   *  doesn't request unmask permission. */
  expirationDate?: string | null
}

export type CreateCustomerProfileResult =
  | { ok: true; customerProfileId: string }
  | { ok: false; error: string; code?: string; existingProfileId?: string }

/**
 * Create a CIM Customer Profile. Idempotent in spirit: if Authorize.net
 * rejects with "merchantCustomerId already exists" (error E00039), we
 * surface the existing profile id so the caller can stamp it without
 * re-creating. The merchantCustomerId is Medusa's customer id truncated
 * to 20 chars (CIM hard limit) — short ULID prefix is unique enough
 * within a single merchant account.
 */
export async function createCustomerProfile(args: {
  medusaCustomerId: string
  email: string
  description?: string
}): Promise<CreateCustomerProfileResult> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  /* Authorize.net hard caps merchantCustomerId at 20 chars. Medusa's
   * cust_<ULID> id is 31 chars — slice the trailing 20 (most-entropy
   * portion). Collisions are theoretically possible but vanishingly
   * unlikely across one merchant's customer base. */
  const merchantCustomerId = args.medusaCustomerId.slice(-20)
  const body = {
    createCustomerProfileRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      profile: {
        merchantCustomerId,
        description: (args.description ?? "B2B wholesale buyer").slice(0, 255),
        email: args.email.slice(0, 255),
      },
      validationMode: "none",
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const id = json?.customerProfileId
    if (id) return { ok: true, customerProfileId: String(id) }
    /* Duplicate-customer error path: Authorize.net returns the existing
     * profile id in customerProfileId even on failure when the
     * merchantCustomerId is already taken. Surface it so the caller
     * can stamp + recover transparently. */
    const err = json?.messages?.message?.[0]
    const code = err?.code as string | undefined
    const existingId = json?.customerProfileId as string | undefined
    return {
      ok: false,
      code,
      error: err?.text ?? "Could not create customer profile",
      existingProfileId: existingId,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during createCustomerProfile" }
  }
}

export type GetCustomerProfileResult =
  | { ok: true; customerProfileId: string; cards: SavedCard[] }
  | { ok: false; error: string; code?: string }

/**
 * Fetch a CIM Customer Profile and return its saved cards in the
 * normalized SavedCard shape. Returns an empty cards array if the
 * profile exists but has no payment profiles attached.
 */
export async function getCustomerProfile(
  customerProfileId: string,
): Promise<GetCustomerProfileResult> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body = {
    getCustomerProfileRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      customerProfileId,
      /* Don't request unmaskExpirationDate — that permission isn't
       * universally granted on Authorize.net accounts, and the buyer-
       * facing list doesn't need real expiry to render "Visa •••• 4242". */
      includeIssuerInfo: false,
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const profile = json?.profile
    if (!profile?.customerProfileId) {
      const err = json?.messages?.message?.[0]
      return {
        ok: false,
        code: err?.code,
        error: err?.text ?? "Customer profile not found",
      }
    }
    const rawProfiles = Array.isArray(profile.paymentProfiles) ? profile.paymentProfiles : []
    const cards: SavedCard[] = []
    for (const p of rawProfiles) {
      const cc = p?.payment?.creditCard
      if (!cc) continue
      const masked: string = typeof cc.cardNumber === "string" ? cc.cardNumber : ""
      /* Mask shape from Authorize.net is "XXXX1234" — last 4 chars are
       * the real digits. Defensively strip any non-digit so weird
       * masks ("****1234") still parse. */
      const last4 = masked.replace(/\D+/g, "").slice(-4)
      cards.push({
        id: String(p.customerPaymentProfileId ?? ""),
        cardType: String(cc.cardType ?? "Card"),
        last4,
        expirationDate: cc.expirationDate ?? null,
      })
    }
    return {
      ok: true,
      customerProfileId: String(profile.customerProfileId),
      cards,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during getCustomerProfile" }
  }
}

export type CreatePaymentProfileResult =
  | { ok: true; customerPaymentProfileId: string; validationDirectResponse?: string }
  | { ok: false; error: string; code?: string }

/**
 * Create a CIM Payment Profile (saved card) on an existing Customer
 * Profile. Uses the Accept.js opaqueData token — raw PAN never reaches
 * us. validationMode "liveMode" runs Authorize.net's standard $0.01
 * auth+void against the card to verify it's chargeable before storing;
 * "none" skips that verification (faster, but stores cards that may
 * fail at first real charge). Default is "liveMode" — we'd rather
 * catch a bad card now than at checkout.
 *
 * The billTo address is required by most Authorize.net merchant
 * accounts with AVS enabled — we use the buyer's saved default billing
 * address. If they have none on file yet, we still attempt the call
 * with a minimal billTo (firstName/lastName) and let Authorize.net
 * decide whether to accept.
 */
export async function createCustomerPaymentProfile(args: {
  customerProfileId: string
  opaqueData: OpaqueData
  billTo: BillingAddress
  validationMode?: "none" | "testMode" | "liveMode"
}): Promise<CreatePaymentProfileResult> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const validationMode =
    args.validationMode ?? (environment === "production" ? "liveMode" : "testMode")
  const body: any = {
    createCustomerPaymentProfileRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      customerProfileId: args.customerProfileId,
      paymentProfile: {
        billTo: addressToAuthNet(args.billTo),
        payment: {
          opaqueData: {
            dataDescriptor: args.opaqueData.dataDescriptor,
            dataValue: args.opaqueData.dataValue,
          },
        },
      },
      validationMode,
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const id = json?.customerPaymentProfileId
    if (id) {
      return {
        ok: true,
        customerPaymentProfileId: String(id),
        validationDirectResponse: json?.validationDirectResponse,
      }
    }
    const err = json?.messages?.message?.[0]
    return {
      ok: false,
      code: err?.code,
      error: err?.text ?? "Could not save card",
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during createCustomerPaymentProfile" }
  }
}

export type GetPaymentProfileResult =
  | { ok: true; card: SavedCard }
  | { ok: false; error: string; code?: string }

/**
 * Fetch a single CIM Payment Profile so we can return the normalized
 * SavedCard shape (cardType + last4) after a create. The create
 * response itself only gives us the new customerPaymentProfileId, not
 * the card metadata — fetching after the fact is the documented pattern
 * for surfacing the saved card to the buyer.
 */
export async function getCustomerPaymentProfile(args: {
  customerProfileId: string
  customerPaymentProfileId: string
}): Promise<GetPaymentProfileResult> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body = {
    getCustomerPaymentProfileRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      customerProfileId: args.customerProfileId,
      customerPaymentProfileId: args.customerPaymentProfileId,
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const profile = json?.paymentProfile
    const cc = profile?.payment?.creditCard
    if (!profile?.customerPaymentProfileId || !cc) {
      const err = json?.messages?.message?.[0]
      return {
        ok: false,
        code: err?.code,
        error: err?.text ?? "Payment profile not found",
      }
    }
    const masked: string = typeof cc.cardNumber === "string" ? cc.cardNumber : ""
    return {
      ok: true,
      card: {
        id: String(profile.customerPaymentProfileId),
        cardType: String(cc.cardType ?? "Card"),
        last4: masked.replace(/\D+/g, "").slice(-4),
        expirationDate: cc.expirationDate ?? null,
      },
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during getCustomerPaymentProfile" }
  }
}

/**
 * Remove a saved card (CIM Payment Profile) from a customer's CIM
 * profile. The CIM Customer Profile itself remains (cheap to keep,
 * needed if the buyer adds another card later).
 */
export async function deleteCustomerPaymentProfile(args: {
  customerProfileId: string
  customerPaymentProfileId: string
}): Promise<{ ok: boolean; error?: string }> {
  const { apiLoginId, transactionKey, environment } = readEnv()
  const body = {
    deleteCustomerPaymentProfileRequest: {
      merchantAuthentication: { name: apiLoginId, transactionKey },
      customerProfileId: args.customerProfileId,
      customerPaymentProfileId: args.customerPaymentProfileId,
    },
  }
  try {
    const json = await postAuthNet(environment, body)
    const resultCode = json?.messages?.resultCode
    if (resultCode === "Ok") return { ok: true }
    const err = json?.messages?.message?.[0]
    return { ok: false, error: err?.text ?? "Could not delete saved card" }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Network error during deleteCustomerPaymentProfile" }
  }
}

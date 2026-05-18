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

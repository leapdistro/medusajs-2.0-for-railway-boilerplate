import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createHash, randomBytes, timingSafeEqual } from "crypto"

/**
 * Account links: the "set your password" link in the welcome email
 * (activation) and in the forgot-password email (reset).
 *
 * Replaces Medusa's reset-password JWT, which is hard-coded to expire in
 * 15 minutes (core-flows generate-reset-password-token: `expiresIn: "15m"`,
 * and generateJwtToken lets that win over any config), can't be revoked
 * and stays reusable until it expires. Buyers opening the welcome email
 * an hour later got "link expired".
 *
 * A link here is:
 *   - a random 32-byte secret, only its SHA-256 hash stored, on the
 *     customer's metadata (`account_link`), with purpose and expiry;
 *   - single use: setting the password moves it to `account_link_used`;
 *   - one at a time: issuing a new link (resend, forgot password)
 *     replaces the stored hash, so every older link stops working;
 *   - never logged (production logs show only that a link was sent).
 *
 * Token format: `<customer id>.<secret>`. The id says which customer to
 * load; it is not secret. A Medusa JWT has three dot-separated parts,
 * ours has two, so the storefront can tell them apart.
 */

export type AccountLinkPurpose = "activation" | "reset"

const HOUR = 60 * 60 * 1000
export const ACCOUNT_LINK_TTL_MS: Record<AccountLinkPurpose, number> = {
  activation: 7 * 24 * HOUR,
  reset: 1 * HOUR,
}

/** "7 days" / "1 hour": the email copy reads the same values as the expiry. */
export function ttlLabel(purpose: AccountLinkPurpose): string {
  const hours = ACCOUNT_LINK_TTL_MS[purpose] / HOUR
  if (hours % 24 === 0) {
    const days = hours / 24
    return `${days} day${days === 1 ? "" : "s"}`
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`
}

/** Stored on customer.metadata.account_link (the one live link). */
export type StoredLink = {
  purpose: AccountLinkPurpose
  hash: string
  sent_at: string
  expires_at: string
}

/** Stored on customer.metadata.account_link_used (the last link spent). */
export type UsedLink = {
  purpose: AccountLinkPurpose
  hash: string
  used_at: string
}

export type LinkState = "valid" | "expired" | "used" | "invalid"

// ─── Pure helpers (unit-tested in account-link.test.ts) ─────────────────

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function sameHash(secret: string, hash: unknown): boolean {
  if (typeof hash !== "string" || !secret) return false
  const a = Buffer.from(hashSecret(secret))
  const b = Buffer.from(hash)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function makeLink(
  customerId: string,
  purpose: AccountLinkPurpose,
  now = Date.now()
): { token: string; stored: StoredLink } {
  const secret = randomBytes(32).toString("base64url")
  return {
    token: `${customerId}.${secret}`,
    stored: {
      purpose,
      hash: hashSecret(secret),
      sent_at: new Date(now).toISOString(),
      expires_at: new Date(now + ACCOUNT_LINK_TTL_MS[purpose]).toISOString(),
    },
  }
}

/** Splits `<customer id>.<secret>`. Anything else (a Medusa JWT, junk) → null. */
export function parseToken(token: unknown): { customerId: string; secret: string } | null {
  if (typeof token !== "string" || token.length > 200) return null
  const parts = token.trim().split(".")
  if (parts.length !== 2) return null
  const [customerId, secret] = parts
  if (!/^cus_[A-Za-z0-9]{8,64}$/.test(customerId)) return null
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(secret)) return null
  return { customerId, secret }
}

/** What a secret means against a customer's metadata. */
export function linkState(
  secret: string,
  metadata: Record<string, any> | null | undefined,
  now = Date.now()
): { state: LinkState; purpose?: AccountLinkPurpose } {
  const live = metadata?.account_link as StoredLink | null | undefined
  if (live && sameHash(secret, live.hash)) {
    const expires = Date.parse(String(live.expires_at ?? ""))
    return { state: expires > now ? "valid" : "expired", purpose: live.purpose }
  }
  const used = metadata?.account_link_used as UsedLink | null | undefined
  if (used && sameHash(secret, used.hash)) {
    return { state: "used", purpose: used.purpose }
  }
  // Replaced by a newer link, or never ours.
  return { state: "invalid" }
}

// ─── Container-backed operations ─────────────────────────────────────────

type Customer = {
  id: string
  email: string
  first_name?: string | null
  metadata?: Record<string, any> | null
}

function storefrontUrl(): string {
  return (process.env.STOREFRONT_URL || "http://localhost:3000").replace(/\/+$/, "")
}

export function linkUrl(token: string): string {
  return `${storefrontUrl()}/auth/reset?${new URLSearchParams({ token }).toString()}`
}

async function loadCustomer(container: any, customerId: string): Promise<Customer | null> {
  const customerService: any = container.resolve(Modules.CUSTOMER)
  try {
    return (await customerService.retrieveCustomer(customerId)) ?? null
  } catch {
    return null
  }
}

/** Customer by email (case-insensitive: applications store it lowercased). */
export async function findCustomerByEmail(container: any, email: string): Promise<Customer | null> {
  const customerService: any = container.resolve(Modules.CUSTOMER)
  const wanted = email.trim().toLowerCase()
  if (!wanted.includes("@")) return null
  const tries = Array.from(new Set([wanted, email.trim()]))
  for (const e of tries) {
    const list = await customerService.listCustomers({ email: [e] }, { take: 1 }).catch(() => [])
    if (list?.[0]) return list[0]
  }
  return null
}

/** True when the customer can sign in with email + password (has an emailpass identity). */
export async function hasPasswordIdentity(container: any, email: string): Promise<boolean> {
  const auth: any = container.resolve(Modules.AUTH)
  try {
    const ids = await auth.listProviderIdentities({ entity_id: email, provider: "emailpass" }, { take: 1 })
    return (ids?.length ?? 0) > 0
  } catch {
    return false
  }
}

export type IssueResult = {
  url: string
  expiresAt: string
  /** false when email isn't configured (local dev) or the send failed */
  emailSent: boolean
  emailError?: string
}

/**
 * Makes a new link for the customer (replacing any older one), saves its
 * hash and emails it. `extraMetadata` is written in the same update (the
 * approve route stamps welcomed_at / application_status with it).
 */
export async function issueAccountLink(
  container: any,
  customer: Customer,
  purpose: AccountLinkPurpose,
  extraMetadata: Record<string, any> = {}
): Promise<IssueResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)

  // Re-read so the write keeps keys other code saved since `customer` was loaded.
  const fresh = (await loadCustomer(container, customer.id)) ?? customer
  const { token, stored } = makeLink(customer.id, purpose)
  await customerService.updateCustomers(customer.id, {
    metadata: {
      ...(fresh.metadata ?? {}),
      ...extraMetadata,
      account_link: stored,
      // Pre-2026-11-24 welcome flag for the Medusa reset subscriber; unused now.
      pending_welcome: null,
    },
  })

  const url = linkUrl(token)
  const result: IssueResult = { url, expiresAt: stored.expires_at, emailSent: false }

  const resendFrom = process.env.RESEND_FROM_EMAIL
  if (!resendFrom) {
    // Local dev without email: the link is only useful if you can see it.
    if (process.env.NODE_ENV !== "production") {
      logger.info(`[account-link] email disabled; ${purpose} link for ${customer.email}: ${url}`)
    } else {
      logger.warn(`[account-link] RESEND_FROM_EMAIL not set; ${purpose} link for ${customer.email} not emailed`)
    }
    result.emailError = "Email is not configured on the backend (RESEND_FROM_EMAIL)."
    return result
  }

  try {
    const notificationService: any = container.resolve(Modules.NOTIFICATION)
    const isWelcome = purpose === "activation"
    await notificationService.createNotifications([{
      to: customer.email,
      channel: "email",
      template: "password-reset",
      from: resendFrom,
      data: {
        emailOptions: {
          subject: isWelcome
            ? "Welcome to Mind Body Spirit — set your password"
            : "Reset your Mind Body Spirit password",
        },
        resetUrl: url,
        isWelcome,
        validFor: ttlLabel(purpose),
      },
    }])
    result.emailSent = true
    logger.info(`[account-link] sent ${purpose} link to ${customer.email} (expires ${stored.expires_at})`)
  } catch (e: any) {
    result.emailError = e?.message ?? String(e)
    logger.warn(`[account-link] ${purpose} email to ${customer.email} failed: ${result.emailError}`)
  }
  return result
}

/** Looks a token up without spending it (the set-password page calls this on load). */
export async function checkAccountLink(
  container: any,
  token: unknown
): Promise<{ state: LinkState; purpose?: AccountLinkPurpose; customer?: Customer }> {
  const parsed = parseToken(token)
  if (!parsed) return { state: "invalid" }
  const customer = await loadCustomer(container, parsed.customerId)
  if (!customer) return { state: "invalid" }
  return { ...linkState(parsed.secret, customer.metadata), customer }
}

export type ConsumeResult =
  | { ok: true; email: string; purpose: AccountLinkPurpose }
  | { ok: false; state: LinkState | "failed"; message: string }

export const STATE_MESSAGES: Record<Exclude<LinkState, "valid">, string> = {
  expired: "This link has expired.",
  used: "This link has already been used.",
  invalid: "This link isn't valid anymore.",
}

/**
 * Sets the password with a valid link and spends it. The link is moved to
 * `account_link_used` before the password changes, so a second submit of
 * the same link reads as "used"; if the password change fails it is put
 * back, so the buyer can try again with the same email.
 */
export async function consumeAccountLink(
  container: any,
  token: unknown,
  password: string
): Promise<ConsumeResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const customerService: any = container.resolve(Modules.CUSTOMER)
  const auth: any = container.resolve(Modules.AUTH)

  const { state, purpose, customer } = await checkAccountLink(container, token)
  if (state !== "valid" || !customer || !purpose) {
    return { ok: false, state, message: STATE_MESSAGES[state as Exclude<LinkState, "valid">] }
  }

  const meta = customer.metadata ?? {}
  const live = meta.account_link as StoredLink
  const usedAt = new Date().toISOString()
  await customerService.updateCustomers(customer.id, {
    metadata: {
      ...meta,
      account_link: null,
      account_link_used: { purpose, hash: live.hash, used_at: usedAt } satisfies UsedLink,
    },
  })

  const { success, error } = await auth
    .updateProvider("emailpass", { entity_id: customer.email, password })
    .catch((e: any) => ({ success: false, error: e?.message ?? String(e) }))

  if (!success) {
    logger.warn(`[account-link] password update failed for ${customer.email}: ${error}`)
    await customerService.updateCustomers(customer.id, {
      metadata: { ...meta, account_link: live },
    }).catch(() => {})
    return { ok: false, state: "failed", message: "Couldn't set your password. Please try again." }
  }

  if (purpose === "activation" && !meta.activated_at) {
    await customerService.updateCustomers(customer.id, {
      metadata: {
        ...meta,
        account_link: null,
        account_link_used: { purpose, hash: live.hash, used_at: usedAt },
        activated_at: usedAt,
      },
    }).catch(() => {})
  }
  logger.info(`[account-link] ${purpose} link used by ${customer.email}`)
  return { ok: true, email: customer.email, purpose }
}

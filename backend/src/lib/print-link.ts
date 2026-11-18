import { createHmac, timingSafeEqual } from "crypto"

/**
 * Short-lived signed links for printing from admin on the storefront
 * (shelf labels, order invoices). The token is `<exp>.<sig>`, signed with
 * the backend's JWT secret over a scope name plus the values it's limited
 * to, valid for LINK_TTL_MS. The storefront passes it back to a /store
 * route that checks it here. The secret never leaves the backend.
 */

const LINK_TTL_MS = 30 * 60 * 1000

const secret = () => process.env.JWT_SECRET || ""

const sign = (scope: string, parts: string[], exp: number) =>
  createHmac("sha256", secret()).update(`${scope}:${[...parts, exp].join("|")}`).digest("base64url")

export function printToken(scope: string, parts: string[], now = Date.now()): string | null {
  if (!secret()) return null
  const exp = Math.floor((now + LINK_TTL_MS) / 1000)
  return `${exp}.${sign(scope, parts, exp)}`
}

export function checkPrintToken(scope: string, parts: string[], token: string, now = Date.now()): boolean {
  if (!secret() || !token || parts.some((p) => !p)) return false
  const [expStr, sig] = token.split(".")
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < now || !sig) return false
  const want = Buffer.from(sign(scope, parts, exp))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got)
}

import { createHmac, timingSafeEqual } from "crypto"

/**
 * Short-lived print links for shelf labels, made in admin.
 *
 * Labels print on the storefront (/labels/<handle>/<format>), which
 * normally needs a signed-in buyer with `labels_enabled`. After a
 * receiving the operator prints from admin instead, so admin hands out a
 * link carrying a token signed with the backend's JWT secret, scoped to
 * one product handle and one label format, valid for LINK_TTL_MS. The
 * storefront passes the token back to /store/mbs/label-settings, which
 * checks it here. The secret never leaves the backend.
 */

const LINK_TTL_MS = 30 * 60 * 1000

const secret = () => process.env.JWT_SECRET || ""

const sign = (payload: string) => createHmac("sha256", secret()).update(`label-link:${payload}`).digest("base64url")

export function labelToken(handle: string, formatId: string, now = Date.now()): string | null {
  if (!secret()) return null
  const exp = Math.floor((now + LINK_TTL_MS) / 1000)
  return `${exp}.${sign(`${handle}|${formatId}|${exp}`)}`
}

export function checkLabelToken(token: string, handle: string, formatId: string, now = Date.now()): boolean {
  if (!secret() || !token || !handle || !formatId) return false
  const [expStr, sig] = token.split(".")
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < now || !sig) return false
  const want = Buffer.from(sign(`${handle}|${formatId}|${exp}`))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got)
}

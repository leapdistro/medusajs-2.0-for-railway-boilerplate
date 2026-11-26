import { createHmac, timingSafeEqual } from "crypto"
import { storefrontBase } from "./products"

/**
 * Unsubscribe links. Token = `<email base64url>.<campaign id or ->.<sig>`,
 * HMAC-SHA256 with the backend's JWT secret. No expiry: an unsubscribe
 * link in an old email must keep working. All it can do is unsubscribe
 * that one address, so it's safe in a URL (it has to be, for the
 * List-Unsubscribe header).
 */

const secret = () => process.env.JWT_SECRET || ""
const sign = (payload: string) => createHmac("sha256", secret()).update(`unsub:${payload}`).digest("base64url").slice(0, 32)

export function unsubscribeToken(email: string, campaignId?: string | null): string | null {
  if (!secret()) return null
  const payload = `${Buffer.from(email.toLowerCase()).toString("base64url")}.${campaignId || "-"}`
  return `${payload}.${sign(payload)}`
}

export function readUnsubscribeToken(token: unknown): { email: string; campaignId: string | null } | null {
  if (typeof token !== "string" || !secret() || token.length > 400) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const payload = `${parts[0]}.${parts[1]}`
  const want = Buffer.from(sign(payload))
  const got = Buffer.from(parts[2])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  const email = Buffer.from(parts[0], "base64url").toString("utf8").toLowerCase()
  if (!email.includes("@")) return null
  return { email, campaignId: parts[1] === "-" ? null : parts[1] }
}

/** The page buyers land on from the footer link. */
export const unsubscribePageUrl = (token: string) => `${storefrontBase()}/unsubscribe?t=${encodeURIComponent(token)}`
/** RFC 8058 one-click endpoint (List-Unsubscribe + List-Unsubscribe-Post). */
export const unsubscribeOneClickUrl = (token: string) => `${storefrontBase()}/api/unsubscribe?t=${encodeURIComponent(token)}`

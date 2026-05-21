import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { randomBytes } from "crypto"
import { buildAuthorizeUrl } from "../../../../lib/qbo-oauth"

/**
 * GET /admin/qbo/connect
 * Generates a CSRF state token, stashes it in the cache module with a
 * 10-minute TTL, and redirects the operator to Intuit's OAuth consent
 * screen. The callback validates + consumes the state — see
 * /admin/qbo/oauth/callback/route.ts.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const state = randomBytes(16).toString("hex")
  try {
    /* Persist the state so the callback can verify it came from a
     * connect kicked off by this server (not a forged Intuit-style
     * redirect). 10 min is generous — Intuit's consent flow is usually
     * sub-minute, but operators get distracted. Cache module defaults
     * to in-memory (see medusa-config.js); good enough since the OAuth
     * round-trip stays on the same backend process. */
    const cache = req.scope.resolve(Modules.CACHE) as {
      set: (k: string, v: unknown, ttlSec?: number) => Promise<void>
    }
    await cache.set(stateCacheKey(state), "1", 60 * 10)

    const url = await buildAuthorizeUrl(state)
    res.redirect(url)
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "QBO not configured" })
  }
}

/** Single source of truth for the cache key — shared with callback. */
export function stateCacheKey(state: string): string {
  return `qbo:oauth:state:${state}`
}

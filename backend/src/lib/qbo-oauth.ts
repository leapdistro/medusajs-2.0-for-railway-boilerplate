/**
 * QuickBooks Online OAuth 2.0 helpers — no external dependency, just
 * fetch. The flow:
 *
 *   1. Operator clicks Connect → buildAuthorizeUrl() generates the
 *      Intuit consent URL with our client_id + redirect_uri.
 *   2. Intuit redirects to /admin/qbo/oauth/callback with ?code + ?realmId.
 *   3. exchangeCodeForTokens() trades the code for access + refresh tokens.
 *   4. Tokens stored in QboConnection table.
 *   5. Before any API call, refreshAccessTokenIfNeeded() checks expiry
 *      and refreshes silently when access token is within 5 min of dying.
 *
 * Token lifetimes: access ~1 hour, refresh ~100 days (sliding window —
 * each refresh extends both back to full duration).
 *
 * Endpoint discovery: Intuit publishes an OpenID Connect discovery
 * document at https://developer.api.intuit.com/.well-known/openid_configuration
 * listing the canonical OAuth endpoints (authorization, token, revoke).
 * We fetch + cache it on first use so endpoint changes from Intuit's side
 * don't require a redeploy. If discovery is unreachable, we fall back to
 * the known-stable hardcoded URLs — these haven't changed in years, so the
 * fallback is safe insurance, not a primary path.
 */

const DISCOVERY_URL = "https://developer.api.intuit.com/.well-known/openid_configuration"

const HARDCODED_FALLBACK = {
  authorize: "https://appcenter.intuit.com/connect/oauth2",
  token:     "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revoke:    "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
} as const

type OAuthEndpoints = {
  authorize: string
  token: string
  revoke: string
}

/* Process-level cache. Railway redeploys re-prime it; that's the only
 * "TTL" we need since Intuit rotates these endpoints on the order of
 * never. In-flight concurrent first-callers share the same Promise to
 * avoid duplicate discovery fetches at cold start. */
let cachedEndpoints: OAuthEndpoints | null = null
let inFlightDiscovery: Promise<OAuthEndpoints> | null = null

async function discoverEndpoints(): Promise<OAuthEndpoints> {
  if (cachedEndpoints) return cachedEndpoints
  if (inFlightDiscovery) return inFlightDiscovery
  inFlightDiscovery = (async () => {
    try {
      const res = await fetch(DISCOVERY_URL, { headers: { Accept: "application/json" } })
      if (res.ok) {
        const doc = (await res.json()) as {
          authorization_endpoint?: string
          token_endpoint?: string
          revocation_endpoint?: string
        }
        if (doc.authorization_endpoint && doc.token_endpoint && doc.revocation_endpoint) {
          cachedEndpoints = {
            authorize: doc.authorization_endpoint,
            token:     doc.token_endpoint,
            revoke:    doc.revocation_endpoint,
          }
          return cachedEndpoints
        }
      }
    } catch { /* fall through to fallback */ }
    cachedEndpoints = { ...HARDCODED_FALLBACK }
    return cachedEndpoints
  })()
  try {
    return await inFlightDiscovery
  } finally {
    inFlightDiscovery = null
  }
}

const SCOPE = "com.intuit.quickbooks.accounting"

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

export type QboTokens = {
  access_token: string
  refresh_token: string
  /** Seconds until access token expires (typically 3600) */
  expires_in: number
  /** Seconds until refresh token expires (typically ~8,726,400 = 101 days) */
  x_refresh_token_expires_in: number
}

function getCredentials() {
  const clientId = process.env.QBO_CLIENT_ID
  const clientSecret = process.env.QBO_CLIENT_SECRET
  const redirectUri = process.env.QBO_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("QBO env vars not configured (QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI)")
  }
  return { clientId, clientSecret, redirectUri }
}

export async function buildAuthorizeUrl(state: string): Promise<string> {
  const { clientId, redirectUri } = getCredentials()
  const { authorize } = await discoverEndpoints()
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
  })
  return `${authorize}?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string): Promise<QboTokens> {
  const { clientId, clientSecret, redirectUri } = getCredentials()
  const { token: tokenEndpoint } = await discoverEndpoints()
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  })
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as QboTokens
}

export async function refreshTokens(refreshToken: string): Promise<QboTokens> {
  const { clientId, clientSecret } = getCredentials()
  const { token: tokenEndpoint } = await discoverEndpoints()
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Token refresh failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as QboTokens
}

export async function revokeToken(token: string): Promise<void> {
  const { clientId, clientSecret } = getCredentials()
  const { revoke: revokeEndpoint } = await discoverEndpoints()
  await fetch(revokeEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token }),
  })
  /* Don't throw on failure — revoke is best-effort; the row in our DB
   * gets deleted regardless so the local state is correct. */
}

export function tokensToConnectionFields(tokens: QboTokens): {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
} {
  const now = Date.now()
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString(),
  }
}

export function accessTokenNeedsRefresh(accessExpiresAt: string): boolean {
  const expiresMs = Date.parse(accessExpiresAt)
  if (Number.isNaN(expiresMs)) return true
  return Date.now() > expiresMs - REFRESH_BUFFER_MS
}

export function qboApiBase(environment: string): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com"
}

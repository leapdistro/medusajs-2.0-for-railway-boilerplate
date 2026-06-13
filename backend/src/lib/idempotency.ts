/* Dynamic require so local tsc doesn't fight pnpm's symlinked
 * `ioredis` resolution; runtime resolves fine on Railway. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis: any = require("ioredis").default ?? require("ioredis")

/**
 * Idempotency-key store backed by Redis.
 *
 * Pattern (mirrors Stripe / AWS):
 *   - Client generates a UUID per logical operation, sends as
 *     `Idempotency-Key` header.
 *   - Server stashes (key → response) for 24h.
 *   - Same key arriving again returns the cached response without
 *     re-executing the underlying handler.
 *   - In-flight lock (60s) prevents simultaneous duplicate execution
 *     from network retries.
 *
 * Soft-fail when REDIS_URL isn't set (local dev without Redis):
 *   - get* returns null → caller proceeds with normal execution
 *   - acquireInflightLock returns true → caller proceeds
 *   - set* is a no-op
 * Net effect: idempotency is a no-op without Redis, never a blocker.
 */

const RESPONSE_TTL_SECONDS = 60 * 60 * 24   // 24h — Stripe convention
const INFLIGHT_LOCK_TTL_SECONDS = 60        // 60s — long enough for most save handlers, short enough to recover from server crashes mid-flight

let client: any = null
let initFailed = false

function getClient(): any {
  if (initFailed) return null
  if (client) return client
  const url = process.env.REDIS_URL
  if (!url) {
    initFailed = true
    return null
  }
  try {
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    })
    client.on("error", (e) => {
      // Log but don't crash — fall through to soft-fail behavior.
      console.warn(`[idempotency] redis error: ${e?.message}`)
    })
    return client
  } catch (e: any) {
    console.warn(`[idempotency] could not connect to redis: ${e?.message}`)
    initFailed = true
    return null
  }
}

export type CachedResponse = {
  status: number
  body: any
  cached_at: number
}

function responseKey(namespace: string, key: string): string {
  return `idempotency:${namespace}:resp:${key}`
}
function inflightKey(namespace: string, key: string): string {
  return `idempotency:${namespace}:lock:${key}`
}

/** Look up a previously-cached response by key. Returns null on miss
 *  OR when Redis is unavailable (treat as miss; let caller proceed). */
export async function getIdempotentResponse(namespace: string, key: string): Promise<CachedResponse | null> {
  const r = getClient()
  if (!r) return null
  try {
    const raw = await r.get(responseKey(namespace, key))
    if (!raw) return null
    return JSON.parse(raw) as CachedResponse
  } catch (e: any) {
    console.warn(`[idempotency] get failed (${namespace}:${key}): ${e?.message}`)
    return null
  }
}

/** Cache a response under the key. Status + body get stored together
 *  so replays return the exact bytes the original handler emitted.
 *  Errors are swallowed — never block the caller's success response. */
export async function setIdempotentResponse(
  namespace: string,
  key: string,
  status: number,
  body: any,
): Promise<void> {
  const r = getClient()
  if (!r) return
  const payload: CachedResponse = { status, body, cached_at: Date.now() }
  try {
    await r.set(responseKey(namespace, key), JSON.stringify(payload), "EX", RESPONSE_TTL_SECONDS)
  } catch (e: any) {
    console.warn(`[idempotency] set failed (${namespace}:${key}): ${e?.message}`)
  }
}

/** Try to acquire the in-flight lock. Returns true if we got it
 *  (caller should proceed), false if another request holds it
 *  (caller should poll for the cached response or 409). Without
 *  Redis, returns true so dev/local flow is unchanged. */
export async function acquireInflightLock(namespace: string, key: string): Promise<boolean> {
  const r = getClient()
  if (!r) return true
  try {
    /* SET key value NX EX seconds — atomic acquire-with-TTL. */
    const ok = await r.set(inflightKey(namespace, key), "1", "EX", INFLIGHT_LOCK_TTL_SECONDS, "NX")
    return ok === "OK"
  } catch (e: any) {
    console.warn(`[idempotency] lock failed (${namespace}:${key}): ${e?.message}`)
    return true   // soft-fail: don't block on Redis hiccup
  }
}

/** Release the in-flight lock. Called from a `finally` block so the
 *  lock doesn't squat for 60s after a fast crash. */
export async function releaseInflightLock(namespace: string, key: string): Promise<void> {
  const r = getClient()
  if (!r) return
  try {
    await r.del(inflightKey(namespace, key))
  } catch { /* ignore */ }
}

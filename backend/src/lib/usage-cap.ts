/* `require` instead of `import` for the same reason as idempotency.ts:
 * ioredis resolution under the Medusa build. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis: any = require("ioredis").default ?? require("ioredis")

/**
 * Fixed-window counters in Redis for public endpoints that cost money
 * per call (the certificate reader). `take` counts one use against
 * every window and says whether all of them still have room.
 *
 * Soft-passes without REDIS_URL (local dev) or when Redis is down:
 * the cap protects the bill, it never blocks a signup.
 */

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
    client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: false })
    client.on("error", (e: any) => console.warn(`[usage-cap] redis error: ${e?.message}`))
    return client
  } catch (e: any) {
    console.warn(`[usage-cap] could not connect to redis: ${e?.message}`)
    initFailed = true
    return null
  }
}

export type UsageWindow = { key: string; limit: number; seconds: number }

export async function takeUsage(windows: UsageWindow[]): Promise<boolean> {
  const redis = getClient()
  if (!redis) return true
  try {
    for (const w of windows) {
      const key = `cap:${w.key}:${Math.floor(Date.now() / 1000 / w.seconds)}`
      const n = await redis.incr(key)
      if (n === 1) await redis.expire(key, w.seconds)
      if (n > w.limit) return false
    }
    return true
  } catch (e: any) {
    console.warn(`[usage-cap] check failed (allowing): ${e?.message}`)
    return true
  }
}

/**
 * Tests for lib/account-link.ts (welcome / forgot-password links).
 *
 * Plain node:test with a fake Medusa container. `@medusajs/framework/utils`
 * is aliased to a stub so the run doesn't load Medusa; <scratch>/utils-stub.js:
 *   module.exports = { Modules: { CUSTOMER: "customer", AUTH: "auth",
 *     NOTIFICATION: "notification" }, ContainerRegistrationKeys: { LOGGER: "logger" } }
 * Then:
 *   node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/bin/esbuild \
 *     src/lib/__tests__/account-link.test.ts --bundle --platform=node \
 *     --alias:@medusajs/framework/utils=<scratch>/utils-stub.js \
 *     --outfile=<scratch>/account-link.test.js \
 *   && node --test <scratch>/account-link.test.js
 */
import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import {
  ACCOUNT_LINK_TTL_MS,
  checkAccountLink,
  consumeAccountLink,
  issueAccountLink,
  linkState,
  makeLink,
  parseToken,
  ttlLabel,
} from "../account-link"

const CUS = "cus_01KABCDEFGHJKMNPQRSTVWXYZ0"

function fakeContainer(opts: { passwordOk?: boolean } = {}) {
  const db: Record<string, any> = {
    [CUS]: { id: CUS, email: "buyer@example.com", metadata: { business_name: "Leaf Co" } },
  }
  const logs: string[] = []
  const emails: any[] = []
  const passwords: Array<{ entity_id: string; password: string }> = []
  const log = (m: string) => logs.push(String(m))
  const services: Record<string, any> = {
    logger: { info: log, warn: log, error: log },
    customer: {
      retrieveCustomer: async (id: string) => {
        if (!db[id]) throw new Error("not found")
        return structuredClone(db[id])
      },
      listCustomers: async ({ email }: any) =>
        Object.values(db).filter((c: any) => email.includes(c.email)).map((c) => structuredClone(c)),
      updateCustomers: async (id: string, patch: any) => {
        db[id] = { ...db[id], ...patch, metadata: { ...patch.metadata } }
      },
    },
    auth: {
      updateProvider: async (_p: string, data: any) => {
        if (opts.passwordOk === false) return { success: false, error: "boom" }
        passwords.push(data)
        return { success: true, authIdentity: {} }
      },
      listProviderIdentities: async () => [{ id: "authid" }],
    },
    notification: { createNotifications: async (n: any[]) => { emails.push(...n) } },
  }
  return {
    container: { resolve: (key: string) => services[key] },
    db, logs, emails, passwords,
  }
}

const tokenFromEmail = (email: any) => new URL(email.data.resetUrl).searchParams.get("token")!

beforeEach(() => {
  process.env.RESEND_FROM_EMAIL = "hello@example.com"
  process.env.STOREFRONT_URL = "https://shop.example.com"
  process.env.NODE_ENV = "production"
})

describe("token format", () => {
  it("round-trips a made link", () => {
    const { token } = makeLink(CUS, "activation")
    const parsed = parseToken(token)
    assert.equal(parsed?.customerId, CUS)
  })
  it("rejects a Medusa JWT, junk and wrong prefixes", () => {
    assert.equal(parseToken("eyJhbGciOiJIUzI1NiJ9.eyJlbnRpdHlfaWQiOiJ4In0.sig"), null)
    assert.equal(parseToken("hello"), null)
    assert.equal(parseToken(`usr_01KABCDEFGHJKMNPQRSTVWXYZ0.${"a".repeat(43)}`), null)
    assert.equal(parseToken(`${CUS}.short`), null)
    assert.equal(parseToken(undefined), null)
  })
  it("labels lifetimes from the same values as the expiry", () => {
    assert.equal(ttlLabel("activation"), "7 days")
    assert.equal(ttlLabel("reset"), "1 hour")
    assert.equal(ACCOUNT_LINK_TTL_MS.activation, 7 * 24 * 3600_000)
  })
})

describe("linkState", () => {
  it("valid before expiry, expired after", () => {
    const now = Date.now()
    const { token, stored } = makeLink(CUS, "activation", now)
    const secret = parseToken(token)!.secret
    assert.equal(linkState(secret, { account_link: stored }, now + 6 * 24 * 3600_000).state, "valid")
    assert.equal(linkState(secret, { account_link: stored }, now + 7 * 24 * 3600_000 + 1).state, "expired")
  })
  it("a different secret is invalid, a spent one is used", () => {
    const a = makeLink(CUS, "reset")
    const b = makeLink(CUS, "reset")
    const secretA = parseToken(a.token)!.secret
    assert.equal(linkState(secretA, { account_link: b.stored }).state, "invalid")
    const used = { purpose: "reset", hash: a.stored.hash, used_at: new Date().toISOString() }
    assert.equal(linkState(secretA, { account_link: b.stored, account_link_used: used }).state, "used")
  })
})

describe("issue → check → consume", () => {
  it("emails a 7-day welcome link, keeps other metadata, logs no secret", async () => {
    const f = fakeContainer()
    const r = await issueAccountLink(f.container, f.db[CUS], "activation", { welcomed_at: "x" })
    assert.equal(r.emailSent, true)
    assert.equal(f.emails.length, 1)
    assert.equal(f.emails[0].data.validFor, "7 days")
    assert.equal(f.emails[0].data.isWelcome, true)
    const token = tokenFromEmail(f.emails[0])
    assert.ok(token.startsWith(`${CUS}.`))
    const secret = parseToken(token)!.secret
    assert.ok(!f.logs.some((l) => l.includes(secret)), "secret must not be logged")
    assert.ok(!JSON.stringify(f.db[CUS].metadata).includes(secret), "only the hash is stored")
    assert.equal(f.db[CUS].metadata.business_name, "Leaf Co")
    assert.equal(f.db[CUS].metadata.welcomed_at, "x")
  })

  it("checking (page load, email scanner) never spends the link", async () => {
    const f = fakeContainer()
    await issueAccountLink(f.container, f.db[CUS], "activation")
    const token = tokenFromEmail(f.emails[0])
    for (let i = 0; i < 3; i++) assert.equal((await checkAccountLink(f.container, token)).state, "valid")
  })

  it("sets the password once; the second try reads as used", async () => {
    const f = fakeContainer()
    await issueAccountLink(f.container, f.db[CUS], "activation")
    const token = tokenFromEmail(f.emails[0])
    const first = await consumeAccountLink(f.container, token, "longenough1")
    assert.deepEqual(first, { ok: true, email: "buyer@example.com", purpose: "activation" })
    assert.deepEqual(f.passwords, [{ entity_id: "buyer@example.com", password: "longenough1" }])
    assert.ok(f.db[CUS].metadata.activated_at)
    assert.equal(f.db[CUS].metadata.account_link, null)
    const second = await consumeAccountLink(f.container, token, "another-pass")
    assert.equal(second.ok, false)
    assert.equal((second as any).state, "used")
    assert.equal(f.passwords.length, 1)
  })

  it("a newer link cancels the older one", async () => {
    const f = fakeContainer()
    await issueAccountLink(f.container, f.db[CUS], "activation")
    await issueAccountLink(f.container, f.db[CUS], "activation")
    const [oldT, newT] = f.emails.map(tokenFromEmail)
    assert.equal((await checkAccountLink(f.container, oldT)).state, "invalid")
    assert.equal((await consumeAccountLink(f.container, oldT, "longenough1")).ok, false)
    assert.equal((await consumeAccountLink(f.container, newT, "longenough1")).ok, true)
  })

  it("an expired link is refused and doesn't change the password", async () => {
    const f = fakeContainer()
    await issueAccountLink(f.container, f.db[CUS], "reset")
    const token = tokenFromEmail(f.emails[0])
    f.db[CUS].metadata.account_link.expires_at = new Date(Date.now() - 1000).toISOString()
    const r = await consumeAccountLink(f.container, token, "longenough1")
    assert.equal((r as any).state, "expired")
    assert.equal(f.passwords.length, 0)
  })

  it("if the password change fails the link still works", async () => {
    const f = fakeContainer({ passwordOk: false })
    await issueAccountLink(f.container, f.db[CUS], "reset")
    const token = tokenFromEmail(f.emails[0])
    const r = await consumeAccountLink(f.container, token, "longenough1")
    assert.equal((r as any).state, "failed")
    assert.equal((await checkAccountLink(f.container, token)).state, "valid")
  })

  it("an unknown customer or tampered secret is invalid", async () => {
    const f = fakeContainer()
    await issueAccountLink(f.container, f.db[CUS], "reset")
    const token = tokenFromEmail(f.emails[0])
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA")
    assert.equal((await checkAccountLink(f.container, tampered)).state, "invalid")
    assert.equal((await checkAccountLink(f.container, `cus_01KZZZZZZZZZZZZZZZZZZZZZZZ.${"a".repeat(43)}`)).state, "invalid")
  })

  it("reports a failed email instead of pretending it sent", async () => {
    const f = fakeContainer()
    ;(f.container.resolve("notification") as any).createNotifications = async () => { throw new Error("resend down") }
    const r = await issueAccountLink(f.container, f.db[CUS], "activation")
    assert.equal(r.emailSent, false)
    assert.match(r.emailError ?? "", /resend down/)
  })
})

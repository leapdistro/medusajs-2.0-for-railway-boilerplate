/**
 * The Resend provider must fail a notification when Resend rejects the
 * email ({ error }, which the SDK returns instead of throwing) or the
 * network fails, so callers like Approve & Send Welcome can say "didn't
 * send". Run like lib/__tests__/account-link.test.ts (esbuild bundle,
 * `@medusajs/framework/utils` stubbed with AbstractNotificationProviderService
 * + MedusaError, `--jsx=automatic --external:resend`, NODE_PATH=node_modules).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ResendNotificationService } from "../services/resend"

const logger: any = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const make = (send: () => Promise<any>) => {
  const svc: any = new ResendNotificationService({ logger }, { api_key: "re_test", from: "MBS <x@hempmbs.com>" })
  svc.resend = { emails: { send } }
  return svc
}
const notification: any = {
  to: "buyer@shop.com", channel: "email", template: "password-reset",
  data: { emailOptions: { subject: "Set your password" }, resetUrl: "https://www.hempmbs.com/auth/reset?token=x", isWelcome: true, validFor: "7 days" },
}

describe("Resend provider", () => {
  it("returns the message id when Resend accepts", async () => {
    const r = await make(async () => ({ data: { id: "re_123" }, error: null })).send(notification)
    assert.deepEqual(r, { id: "re_123" })
  })
  it("throws when Resend rejects (SDK returns { error })", async () => {
    await assert.rejects(
      make(async () => ({ data: null, error: { name: "validation_error", message: "The hempmbs.com domain is not verified" } })).send(notification),
      /Resend rejected "password-reset" email to buyer@shop.com: validation_error - The hempmbs.com domain is not verified/,
    )
  })
  it("throws on a network failure", async () => {
    await assert.rejects(make(async () => { throw new Error("ECONNRESET") }).send(notification), /ECONNRESET/)
  })
})

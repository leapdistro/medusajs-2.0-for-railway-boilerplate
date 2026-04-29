import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import Anthropic from "@anthropic-ai/sdk"

/**
 * Smoke test — verifies the ANTHROPIC_API_KEY env var is set and the
 * key actually reaches the Anthropic API. Sends a tiny request that
 * should always succeed if creds are valid.
 *
 * Run: pnpm test:anthropic
 */
export default async function testAnthropic({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    logger.error("✗ ANTHROPIC_API_KEY env var is not set")
    return
  }
  logger.info(`✓ ANTHROPIC_API_KEY present (${key.slice(0, 12)}…)`)

  const client = new Anthropic({ apiKey: key })

  logger.info("▶ Sending test message to Anthropic…")
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      messages: [
        { role: "user", content: 'Reply with exactly: {"status":"ok"}' },
      ],
    })

    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("")

    logger.info("─────────────── Response ───────────────")
    logger.info(`model:       ${res.model}`)
    logger.info(`stop_reason: ${res.stop_reason}`)
    logger.info(`input_tokens:  ${res.usage.input_tokens}`)
    logger.info(`output_tokens: ${res.usage.output_tokens}`)
    logger.info(`text:        ${text}`)
    logger.info("────────────────────────────────────────")

    if (text.includes("ok")) {
      logger.info("✓ Anthropic API working — ready for Slice 2A (extraction)")
    } else {
      logger.warn("? Got a response but unexpected content. Inspect above.")
    }
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status
    const message = e?.message ?? String(e)
    logger.error(`✗ Anthropic call failed (status=${status ?? "unknown"})`)
    logger.error(message)
    if (status === 401) logger.error("  → Auth failed. Check the key value in Railway env vars.")
    if (status === 429) logger.error("  → Rate limited. Wait a bit + retry.")
    if (status === 400) logger.error("  → Bad request. Likely a model name issue.")
  }
}

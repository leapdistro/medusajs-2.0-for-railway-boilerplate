import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { exchangeCodeForTokens, tokensToConnectionFields } from "../../../../../lib/qbo-oauth"
import { QBO_CONNECTION_MODULE } from "../../../../../modules/qbo-connection"

/**
 * GET /admin/qbo/oauth/callback?code=...&realmId=...&state=...
 *
 * The redirect target Intuit sends the operator to after they authorize
 * the connection. We swap the code for tokens, store them (alongside the
 * realmId, which is the QBO company ID), and bounce the operator back to
 * our admin's QuickBooks settings page.
 *
 * On error (operator denies, network fails, etc.) we redirect with a
 * ?error= query the settings page can surface.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const qbo: any = req.scope.resolve(QBO_CONNECTION_MODULE)

  const code = String(req.query.code ?? "")
  const realmId = String(req.query.realmId ?? "")
  const error = String(req.query.error ?? "")
  const environment = process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox"

  if (error) {
    logger.warn(`[qbo/callback] denied: ${error}`)
    return res.redirect(`/app/quickbooks?error=${encodeURIComponent(error)}`)
  }
  if (!code || !realmId) {
    return res.redirect(`/app/quickbooks?error=${encodeURIComponent("missing_code_or_realm")}`)
  }

  try {
    const tokens = await exchangeCodeForTokens(code)
    const tokenFields = tokensToConnectionFields(tokens)

    /* Single-connection table: replace any existing row so a re-connect
     * with a different sandbox / company cleanly overwrites. */
    const existing = await qbo.listQboConnections({}, { take: 1 })
    if (existing.length > 0) {
      await qbo.updateQboConnections({
        id: existing[0].id,
        realm_id: realmId,
        environment,
        company_name: null,
        ...tokenFields,
      })
    } else {
      await qbo.createQboConnections({
        realm_id: realmId,
        environment,
        company_name: null,
        last_bill_pushed_at: null,
        last_bill_id: null,
        ...tokenFields,
      })
    }

    logger.info(`[qbo/callback] connected realm=${realmId} env=${environment}`)
    return res.redirect(`/app/quickbooks?connected=1`)
  } catch (e: any) {
    logger.error(`[qbo/callback] failed: ${e?.message}`)
    return res.redirect(`/app/quickbooks?error=${encodeURIComponent(e?.message ?? "exchange_failed")}`)
  }
}

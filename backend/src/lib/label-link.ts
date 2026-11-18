import { checkPrintToken, printToken } from "./print-link"

/**
 * Short-lived print links for shelf labels, made in admin.
 *
 * Labels print on the storefront (/labels/<handle>/<format>), which
 * normally needs a signed-in buyer with `labels_enabled`. After a
 * receiving the operator prints from admin instead, so admin hands out a
 * link carrying a signed token (lib/print-link.ts), scoped to one product
 * handle and one label format. The storefront passes the token back to
 * /store/mbs/label-settings, which checks it here.
 */

export function labelToken(handle: string, formatId: string, now = Date.now()): string | null {
  return printToken("label-link", [handle, formatId], now)
}

export function checkLabelToken(token: string, handle: string, formatId: string, now = Date.now()): boolean {
  return checkPrintToken("label-link", [handle, formatId], token, now)
}

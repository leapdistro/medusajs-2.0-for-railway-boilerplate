/**
 * QuickBooks Online API helpers — wraps the handful of v3 endpoints we
 * need for slice 2 (Bill push from receiving): CompanyInfo, Vendor
 * find/create, Item find/create, Bill create.
 *
 * Every call goes through withFreshAccessToken which refreshes the
 * access token if it's within 5 min of expiry. The token row in
 * qbo_connection is updated transparently — callers don't need to
 * worry about expiry.
 */

import { accessTokenNeedsRefresh, qboApiBase, refreshTokens, tokensToConnectionFields } from "./qbo-oauth"

type QboConnectionRow = {
  id: string
  realm_id: string
  environment: string
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
  company_name: string | null
  last_bill_pushed_at: string | null
  last_bill_id: string | null
}

type QboService = {
  updateQboConnections: (input: any) => Promise<any>
}

/**
 * Ensures the access token on the connection is fresh enough to use.
 * If a refresh happened, persists the new tokens on the row and mutates
 * the in-memory copy so subsequent calls in the same request use them.
 */
async function ensureFreshAccessToken(
  qbo: QboService,
  connection: QboConnectionRow,
): Promise<QboConnectionRow> {
  if (!accessTokenNeedsRefresh(connection.access_expires_at)) return connection
  const tokens = await refreshTokens(connection.refresh_token)
  const fields = tokensToConnectionFields(tokens)
  await qbo.updateQboConnections({ id: connection.id, ...fields })
  return { ...connection, ...fields }
}

async function qboFetch(
  connection: QboConnectionRow,
  path: string,
  init?: RequestInit,
): Promise<any> {
  const base = qboApiBase(connection.environment)
  const url = `${base}/v3/company/${connection.realm_id}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`QBO ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body.slice(0, 400)}`)
  }
  return res.json()
}

/* ─── Company info (for displaying the QBO company name in admin) ─── */

export async function getCompanyInfo(qbo: QboService, conn: QboConnectionRow): Promise<{ name: string }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const json = await qboFetch(fresh, `/companyinfo/${fresh.realm_id}`)
  return { name: json?.CompanyInfo?.CompanyName ?? "" }
}

/* ─── Vendor find-or-create ─── */

export async function findOrCreateVendor(
  qbo: QboService,
  conn: QboConnectionRow,
  supplier: { name: string; email?: string | null; phone?: string | null; address?: string | null },
): Promise<{ id: string; displayName: string; created: boolean }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  /* QBO Query language is SQL-ish. Quote single quotes in the value by
   * doubling them (the standard QBO escape). */
  const safe = supplier.name.replace(/'/g, "''")
  const query = `select * from Vendor where DisplayName = '${safe}'`
  const found = await qboFetch(fresh, `/query?query=${encodeURIComponent(query)}`)
  const existing = found?.QueryResponse?.Vendor?.[0]
  if (existing) {
    return { id: String(existing.Id), displayName: existing.DisplayName, created: false }
  }

  const body: any = { DisplayName: supplier.name }
  if (supplier.email) body.PrimaryEmailAddr = { Address: supplier.email }
  if (supplier.phone) body.PrimaryPhone = { FreeFormNumber: supplier.phone }
  if (supplier.address) body.BillAddr = { Line1: supplier.address }

  const created = await qboFetch(fresh, `/vendor`, { method: "POST", body: JSON.stringify(body) })
  const v = created?.Vendor
  if (!v?.Id) throw new Error(`Vendor create returned no Id: ${JSON.stringify(created).slice(0, 200)}`)
  return { id: String(v.Id), displayName: v.DisplayName, created: true }
}

/* ─── Item find-or-create (Inventory type) ─── */

type AccountRef = { id: string; name: string }

export async function getDefaultAccounts(
  qbo: QboService,
  conn: QboConnectionRow,
): Promise<{ inventoryAsset: AccountRef; incomeAccount: AccountRef; cogsAccount: AccountRef }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  /* Standard QBO chart of accounts has these by default. QBQL doesn't
   * support OR — query each account by its most reliable identifier:
   * - Inventory Asset: AccountSubType = 'Inventory'
   * - Sales of Product Income: AccountSubType = 'SalesOfProductIncome'
   * - Cost of Goods Sold: AccountType = 'Cost of Goods Sold' (parent
   *   type — covers SuppliesMaterialsCogs and any other COGS sub-types). */
  const queries: Array<[keyof Awaited<ReturnType<typeof getDefaultAccounts>>, string]> = [
    ["inventoryAsset", "select * from Account where AccountSubType = 'Inventory'"],
    ["incomeAccount",  "select * from Account where AccountSubType = 'SalesOfProductIncome'"],
    ["cogsAccount",    "select * from Account where AccountType = 'Cost of Goods Sold'"],
  ]
  const result: any = {}
  for (const [key, q] of queries) {
    const json = await qboFetch(fresh, `/query?query=${encodeURIComponent(q)}`)
    const acc = json?.QueryResponse?.Account?.[0]
    if (!acc) throw new Error(`Could not locate default ${key} account in QBO`)
    result[key] = { id: String(acc.Id), name: acc.Name }
  }
  return result
}

export async function findOrCreateItem(
  qbo: QboService,
  conn: QboConnectionRow,
  itemName: string,
  accounts: { inventoryAsset: AccountRef; incomeAccount: AccountRef; cogsAccount: AccountRef },
  defaults?: {
    purchaseCost?: number               // landed cost / QP (Cost field in QBO UI)
    salePrice?: number                  // selling price (Sales Price/Rate in QBO UI)
    preferredVendor?: { id: string; name: string }
    purchaseDesc?: string               // shown on bills
    salesDesc?: string                  // shown on invoices/sales receipts
  },
): Promise<{ id: string; name: string; created: boolean }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = itemName.replace(/'/g, "''")
  const query = `select * from Item where Name = '${safe}'`
  const found = await qboFetch(fresh, `/query?query=${encodeURIComponent(query)}`)
  const existing = found?.QueryResponse?.Item?.[0]
  if (existing) {
    return { id: String(existing.Id), name: existing.Name, created: false }
  }

  /* Create as Inventory item — tracks stock + COGS. TrackQtyOnHand
   * requires InvStartDate + QtyOnHand. We set QtyOnHand to 0 because
   * the Bill we're about to push will be the inventory adjustment.
   *
   * Defaults (PurchaseCost / UnitPrice / PreferredVendorRef) are set
   * only on creation — operators can override them in QBO and we won't
   * clobber. Future receivings of the same item don't touch these
   * fields, even if prices have changed (the Bill itself carries the
   * actual cost for that receiving's COGS posting). */
  const today = new Date().toISOString().slice(0, 10)
  const body: any = {
    Name: itemName,
    Type: "Inventory",
    TrackQtyOnHand: true,
    QtyOnHand: 0,
    InvStartDate: today,
    AssetAccountRef:  { value: accounts.inventoryAsset.id, name: accounts.inventoryAsset.name },
    IncomeAccountRef: { value: accounts.incomeAccount.id, name: accounts.incomeAccount.name },
    ExpenseAccountRef:{ value: accounts.cogsAccount.id,    name: accounts.cogsAccount.name },
  }
  if (defaults?.purchaseCost != null) body.PurchaseCost = round2(defaults.purchaseCost)
  if (defaults?.salePrice != null) body.UnitPrice = round2(defaults.salePrice)
  if (defaults?.preferredVendor) {
    body.PreferredVendorRef = { value: defaults.preferredVendor.id, name: defaults.preferredVendor.name }
  }
  if (defaults?.purchaseDesc) body.PurchaseDesc = defaults.purchaseDesc
  if (defaults?.salesDesc) body.Description = defaults.salesDesc

  const created = await qboFetch(fresh, `/item`, { method: "POST", body: JSON.stringify(body) })
  const item = created?.Item
  if (!item?.Id) throw new Error(`Item create returned no Id: ${JSON.stringify(created).slice(0, 200)}`)
  return { id: String(item.Id), name: item.Name, created: true }
}

/* ─── Bill creation ─── */

export type BillLine = {
  itemId: string
  itemName: string
  qty: number        // QPs received
  rate: number       // landed cost per QP (dollars; shipping already capitalized)
  description?: string
}

export async function createBill(
  qbo: QboService,
  conn: QboConnectionRow,
  args: {
    vendorId: string
    invoiceNumber: string
    invoiceDate: string         // YYYY-MM-DD (QBO TxnDate)
    lines: BillLine[]
    privateNote?: string
  },
): Promise<{ id: string; docNumber: string | null }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const Line = args.lines.map((l, i) => ({
    Id: String(i + 1),
    DetailType: "ItemBasedExpenseLineDetail",
    Amount: round2(l.qty * l.rate),
    Description: l.description ?? "",
    ItemBasedExpenseLineDetail: {
      ItemRef: { value: l.itemId, name: l.itemName },
      Qty: l.qty,
      UnitPrice: l.rate,
      BillableStatus: "NotBillable",
    },
  }))
  const body: any = {
    VendorRef: { value: args.vendorId },
    TxnDate: args.invoiceDate,
    DocNumber: args.invoiceNumber.slice(0, 21),  // QBO limit
    Line,
  }
  if (args.privateNote) body.PrivateNote = args.privateNote.slice(0, 4000)
  const created = await qboFetch(fresh, `/bill`, { method: "POST", body: JSON.stringify(body) })
  const bill = created?.Bill
  if (!bill?.Id) throw new Error(`Bill create returned no Id: ${JSON.stringify(created).slice(0, 400)}`)
  return { id: String(bill.Id), docNumber: bill.DocNumber ?? null }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function billPublicUrl(environment: string, realmId: string, billId: string): string {
  /* QBO doesn't have a stable public deep-link to a specific Bill,
   * but the closest is the App vendor center. Operators usually
   * navigate from Vendors → Bills, so a generic vendor-bills URL is
   * good enough for the success card to link to. */
  return environment === "production"
    ? `https://app.qbo.intuit.com/app/bill?txnId=${billId}`
    : `https://app.sandbox.qbo.intuit.com/app/bill?txnId=${billId}`
}

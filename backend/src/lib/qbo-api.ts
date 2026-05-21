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
  /* intuit_tid is Intuit's per-request correlation id. Including it in
   * thrown errors + a stamped console line lets Intuit support look up
   * the exact request in their logs when troubleshooting — saves a lot
   * of back-and-forth on support tickets. */
  const tid = res.headers.get("intuit_tid") || res.headers.get("Intuit_Tid") || ""
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(
      `QBO ${init?.method ?? "GET"} ${path} failed: ${res.status} intuit_tid=${tid || "n/a"} ${body.slice(0, 400)}`,
    )
  }
  /* Successful calls also log the tid at debug-equivalent volume — keep
   * it cheap (single console.info) so we have correlation ids on every
   * call without dragging in a structured-log dep. */
  if (tid) console.info(`[qbo] ${init?.method ?? "GET"} ${path} ok intuit_tid=${tid}`)
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

/* ─── Customer find-or-create ─── */

export type CustomerInput = {
  /** Wholesale account business name — used as DisplayName + CompanyName. */
  businessName: string
  email: string
  phone?: string | null
  /** Mailing/billing address fields. */
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  /** Contact person name. Split fields map to QBO's GivenName/FamilyName
   *  (which power "Title, First Name, Last Name" defaults). Falls back to
   *  the legacy combined string in Notes when only contactName is set. */
  firstName?: string | null
  lastName?: string | null
  contactName?: string | null
  /** Business category label (Smoke Shop / Dispensary / etc.) — rendered
   *  in Notes since QBO has no native field for buyer business type. */
  businessTypeLabel?: string | null
  /** Net 15 / Net 30 / Due on Receipt etc. — Sales Term ID from QBO. */
  salesTermId?: string | null
  notes?: string | null
}

export async function findQboTermIdByName(
  qbo: QboService,
  conn: QboConnectionRow,
  termName: string,
): Promise<string | null> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = termName.replace(/'/g, "''")
  const query = `select * from Term where Name = '${safe}'`
  const json = await qboFetch(fresh, `/query?query=${encodeURIComponent(query)}`)
  const term = json?.QueryResponse?.Term?.[0]
  return term ? String(term.Id) : null
}

export async function findOrCreateCustomer(
  qbo: QboService,
  conn: QboConnectionRow,
  input: CustomerInput,
): Promise<{ id: string; displayName: string; created: boolean }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  /* Match priority: email first (most reliable), then DisplayName as a
   * fallback for legacy data without email on file. */
  const safeEmail = input.email.replace(/'/g, "''")
  const byEmail = await qboFetch(
    fresh,
    `/query?query=${encodeURIComponent(`select * from Customer where PrimaryEmailAddr = '${safeEmail}'`)}`,
  )
  const existing = byEmail?.QueryResponse?.Customer?.[0]
  if (existing) {
    return { id: String(existing.Id), displayName: existing.DisplayName, created: false }
  }

  const body: any = {
    DisplayName: input.businessName.slice(0, 500),
    CompanyName: input.businessName.slice(0, 1024),
    PrimaryEmailAddr: { Address: input.email },
  }
  /* QBO's GivenName / FamilyName are the "Title, First, Last" components
   * on a Customer. Setting them powers Customer Center's name column +
   * any merge-field templates that reference {{Customer.Name}}. */
  if (input.firstName) body.GivenName  = input.firstName.slice(0, 100)
  if (input.lastName)  body.FamilyName = input.lastName.slice(0, 100)
  if (input.phone) body.PrimaryPhone = { FreeFormNumber: input.phone }
  if (input.addressLine1 || input.city || input.state || input.zip) {
    body.BillAddr = {
      Line1: input.addressLine1 ?? undefined,
      Line2: input.addressLine2 ?? undefined,
      City: input.city ?? undefined,
      CountrySubDivisionCode: input.state ?? undefined,  // QBO US state field
      PostalCode: input.zip ?? undefined,
      Country: input.country ?? undefined,
    }
    /* Most B2B wholesale ships to the billing address; if the operator
     * needs separate ship-to later they'll set it in QBO. */
    body.ShipAddr = { ...body.BillAddr }
  }
  if (input.salesTermId) body.SalesTermRef = { value: input.salesTermId }
  /* Notes carries context that doesn't have a first-class QBO field. */
  const noteParts: string[] = []
  if (input.businessTypeLabel) noteParts.push(`Business Type: ${input.businessTypeLabel}`)
  /* Only fall back to combined contactName in Notes when GivenName/
   * FamilyName aren't set — otherwise it's just visual noise. */
  if (input.contactName && !input.firstName && !input.lastName) {
    noteParts.push(`Contact: ${input.contactName}`)
  }
  if (input.notes) noteParts.push(input.notes)
  if (noteParts.length > 0) body.Notes = noteParts.join(" · ").slice(0, 2000)

  const created = await qboFetch(fresh, `/customer`, { method: "POST", body: JSON.stringify(body) })
  const c = created?.Customer
  if (!c?.Id) throw new Error(`Customer create returned no Id: ${JSON.stringify(created).slice(0, 200)}`)
  return { id: String(c.Id), displayName: c.DisplayName, created: true }
}

/* ─── Customer attachment upload (Attachable API) ─── */

/**
 * Push a file from a public URL (our MinIO bucket today) to QBO and link
 * it to a Customer as an Attachable. QBO's /upload endpoint is multipart
 * with TWO parts:
 *   - file_metadata_0: JSON describing the AttachableRef + filename + MIME
 *   - file_content_0:  raw file bytes with matching Content-Type
 *
 * We can't reuse qboFetch because it pins Content-Type to application/json
 * — multipart needs FormData to set its own boundary.
 *
 * Returns the new Attachable.Id so the caller can stamp it on customer
 * metadata for idempotency on subsequent approvals.
 */
export async function uploadCustomerAttachment(
  qbo: QboService,
  connection: QboConnectionRow,
  args: {
    customerId: string
    sourceUrl: string
    fileName: string
    note?: string | null
  },
): Promise<{ id: string; fileName: string }> {
  const fresh = await ensureFreshAccessToken(qbo, connection)

  /* 1. Fetch source bytes from the storage URL. The apply route uploads
   *    via Medusa's file service which currently returns public URLs;
   *    if the storage backend changes to signed/private URLs later, this
   *    helper would need a signed-fetch path. */
  const fileRes = await fetch(args.sourceUrl)
  if (!fileRes.ok) {
    throw new Error(`Source file fetch failed for ${args.sourceUrl}: ${fileRes.status}`)
  }
  const arrayBuffer = await fileRes.arrayBuffer()
  const contentType =
    contentTypeFromUrl(args.sourceUrl) ||
    fileRes.headers.get("content-type") ||
    "application/octet-stream"

  /* 2. Build the AttachableRef metadata block. IncludeOnSend=false so the
   *    EIN / resale cert doesn't auto-attach to outbound invoices — these
   *    are internal compliance docs, not buyer-facing. */
  const metadata = {
    AttachableRef: [
      {
        EntityRef: { type: "Customer", value: args.customerId },
        IncludeOnSend: false,
      },
    ],
    FileName: args.fileName,
    ContentType: contentType,
    ...(args.note ? { Note: args.note.slice(0, 2000) } : {}),
  }

  /* 3. Assemble multipart and POST to /upload. */
  const form = new FormData()
  form.append(
    "file_metadata_0",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  )
  form.append(
    "file_content_0",
    new Blob([arrayBuffer], { type: contentType }),
    args.fileName,
  )

  const base = qboApiBase(fresh.environment)
  const url = `${base}/v3/company/${fresh.realm_id}/upload`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fresh.access_token}`,
      Accept: "application/json",
      /* Deliberately NO Content-Type — fetch + FormData pick the right
       * multipart/form-data boundary themselves. Setting one breaks parsing. */
    },
    body: form,
  })
  const tid = res.headers.get("intuit_tid") || res.headers.get("Intuit_Tid") || ""
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`QBO upload failed: ${res.status} intuit_tid=${tid || "n/a"} ${body.slice(0, 400)}`)
  }
  const json = await res.json()
  /* QBO's /upload returns 200 OK even when the attachment failed —
   * Stale Object Error etc. surface as embedded Fault. Caller needs
   * to see intuit_tid for those too. */
  const att = json?.AttachableResponse?.[0]?.Attachable
  if (!att?.Id) {
    throw new Error(
      `QBO upload returned no Attachable: intuit_tid=${tid || "n/a"} ${JSON.stringify(json).slice(0, 200)}`,
    )
  }
  if (tid) console.info(`[qbo] POST /upload ok intuit_tid=${tid}`)
  return { id: String(att.Id), fileName: String(att.FileName ?? args.fileName) }
}

function contentTypeFromUrl(url: string): string | null {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    pdf:  "application/pdf",
    png:  "image/png",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    gif:  "image/gif",
    webp: "image/webp",
  }
  return map[ext] ?? null
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
    /** Disambiguated name to retry with if QBO rejects `itemName` as
     *  a duplicate. Used to keep clean strain-only names where possible
     *  ("Wedding Cake") and only add a tier suffix ("Wedding Cake · Rapper")
     *  when an item with the same strain exists in a different category.
     *  When parentCategoryId is set, find-phase also scopes to that
     *  category so an existing same-named item in a different category
     *  doesn't get incorrectly returned. */
    fallbackName?: string
    sku?: string                        // QBO Item SKU (matches Medusa base SKU for cross-ref)
    purchaseCost?: number               // landed cost / QP (Cost field in QBO UI)
    salePrice?: number                  // selling price (Sales Price/Rate in QBO UI)
    preferredVendor?: { id: string; name: string }
    purchaseDesc?: string               // shown on bills
    salesDesc?: string                  // shown on invoices/sales receipts
    /** YYYY-MM-DD — pass the Bill's TxnDate so QBO doesn't reject the
     *  Bill with "Transaction date is prior to start date for inventory
     *  item" when the invoice is dated before today. */
    invStartDate?: string
    /** QBO Category id to nest this Item under (Sales > Products and
     *  Services Category column). Mirrors the Medusa product_category
     *  hierarchy. Set on creation only — existing items aren't re-parented. */
    parentCategoryId?: string
  },
): Promise<{ id: string; name: string; created: boolean }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = itemName.replace(/'/g, "''")
  const query = `select * from Item where Name = '${safe}'`
  const found = await qboFetch(fresh, `/query?query=${encodeURIComponent(query)}`)
  const candidates = (found?.QueryResponse?.Item ?? []) as any[]
  /* When parentCategoryId is set (Items mapped to a QBO Category), only
   * accept an existing item that lives under THAT category — otherwise
   * a "Wedding Cake" in a different tier would be returned incorrectly.
   * Without a parent constraint, accept any same-named item (legacy
   * behavior). */
  const existing = defaults?.parentCategoryId
    ? candidates.find((c) => String(c?.ParentRef?.value ?? "") === defaults.parentCategoryId)
    : candidates[0]
  if (existing) {
    /* If the caller wants an earlier InvStartDate than the item already
     * has (e.g., a past-dated invoice for an item created today), push
     * a sparse update before returning. QBO will reject the Bill with
     * error 6270 otherwise. If the item already has transactions, this
     * update will fail — the Bill POST that follows will surface the
     * error so the operator knows to delete + recreate the item or
     * adjust the invoice date. */
    if (defaults?.invStartDate && existing.InvStartDate) {
      const existingStart = String(existing.InvStartDate).slice(0, 10)
      const requested = defaults.invStartDate.slice(0, 10)
      if (existingStart > requested) {
        try {
          await qboFetch(fresh, `/item`, {
            method: "POST",
            body: JSON.stringify({
              Id: existing.Id,
              SyncToken: existing.SyncToken,
              sparse: true,
              InvStartDate: requested,
            }),
          })
        } catch (e: any) {
          /* Non-fatal here — surface the original Bill error to the
           * operator who can then decide to delete the item in QBO. */
          console.warn(`[qbo] failed to update InvStartDate on ${itemName}: ${e?.message}`)
        }
      }
    }
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
  /* InvStartDate must be on or before any Bill that references this
   * item. Default to today only when the caller didn't supply one. */
  const today = new Date().toISOString().slice(0, 10)
  const body: any = {
    Name: itemName,
    Type: "Inventory",
    TrackQtyOnHand: true,
    QtyOnHand: 0,
    InvStartDate: defaults?.invStartDate || today,
    AssetAccountRef:  { value: accounts.inventoryAsset.id, name: accounts.inventoryAsset.name },
    IncomeAccountRef: { value: accounts.incomeAccount.id, name: accounts.incomeAccount.name },
    ExpenseAccountRef:{ value: accounts.cogsAccount.id,    name: accounts.cogsAccount.name },
  }
  if (defaults?.sku) body.Sku = defaults.sku.slice(0, 100) // QBO Sku limit is 100 chars
  if (defaults?.purchaseCost != null) body.PurchaseCost = round2(defaults.purchaseCost)
  if (defaults?.salePrice != null) body.UnitPrice = round2(defaults.salePrice)
  if (defaults?.parentCategoryId) {
    body.ParentRef = { value: defaults.parentCategoryId }
    body.SubItem = true
  }
  if (defaults?.preferredVendor) {
    /* QBO API field name is `PrefVendorRef` (not `PreferredVendorRef`),
     * even though the UI label is "Preferred Vendor". */
    body.PrefVendorRef = { value: defaults.preferredVendor.id, name: defaults.preferredVendor.name }
  }
  if (defaults?.purchaseDesc) body.PurchaseDesc = defaults.purchaseDesc
  if (defaults?.salesDesc) body.Description = defaults.salesDesc

  let created
  try {
    created = await qboFetch(fresh, `/item`, { method: "POST", body: JSON.stringify(body) })
  } catch (e: any) {
    /* QBO rejects duplicate Item.Name globally (error code 6240 or
     * generic "Duplicate Name Exists Error"). If the caller supplied a
     * fallbackName (disambiguated form like "Wedding Cake · Rapper"),
     * retry once with that name. This lets us TRY the clean strain
     * name first and only fall back to the suffixed form when an item
     * with the same strain exists in a different category. */
    const msg = String(e?.message ?? "")
    const isDuplicate = /duplicate name/i.test(msg) || /6240/.test(msg)
    if (isDuplicate && defaults?.fallbackName && defaults.fallbackName !== itemName) {
      body.Name = defaults.fallbackName
      created = await qboFetch(fresh, `/item`, { method: "POST", body: JSON.stringify(body) })
    } else {
      throw e
    }
  }
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

/**
 * Strip the trailing variant-size segment off a Medusa variant SKU to
 * get the base SKU we stamped on the QBO Item. Variant SKUs are
 * `<cat-3>-<sub-3>-<type-3>-<strain-abbrev>-<size>` and we always set
 * QBO Item.Sku = same minus the size. Size is always one hyphen-segment.
 */
export function baseFromVariantSku(variantSku: string): string {
  return variantSku.replace(/-[^-]+$/, "")
}

/* ─── Item Category find-or-create (Type: Category) ─── */

/**
 * QBO Item Categories are internally Items with Type="Category" — they
 * group product Items in the Sales > Products and Services list and on
 * reports (Sales by Category, etc.). Each real Item picks one via
 * ParentRef. Up to two levels (parent + child).
 *
 * Name uniqueness: QBO enforces global uniqueness across ALL Items
 * including Categories. So a Category "Super" and a regular Item "Super"
 * can't coexist. Our setup uses strain·subcat names ("Strain · Super")
 * which never collide with raw subcategory names.
 */
export async function findOrCreateItemCategory(
  qbo: QboService,
  conn: QboConnectionRow,
  name: string,
  parentId?: string,
): Promise<{ id: string; name: string; created: boolean }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = name.replace(/'/g, "''")
  const found = await qboFetch(
    fresh,
    `/query?query=${encodeURIComponent(`select * from Item where Name = '${safe}' and Type = 'Category'`)}`,
  )
  const existing = found?.QueryResponse?.Item?.[0]
  if (existing) {
    return { id: String(existing.Id), name: existing.Name, created: false }
  }

  const body: any = {
    Name: name,
    Type: "Category",
  }
  if (parentId) {
    body.ParentRef = { value: parentId }
    body.SubItem = true
  }
  const created = await qboFetch(fresh, `/item`, { method: "POST", body: JSON.stringify(body) })
  const item = created?.Item
  if (!item?.Id) throw new Error(`Item Category create returned no Id: ${JSON.stringify(created).slice(0, 200)}`)
  return { id: String(item.Id), name: item.Name, created: true }
}

/**
 * Resolve a category chain (parent name → ... → leaf name) into the
 * leaf Category's QBO id, creating each level if missing. Empty chain
 * returns undefined (item lives at QBO root).
 */
export async function resolveCategoryChain(
  qbo: QboService,
  conn: QboConnectionRow,
  names: string[],
): Promise<string | undefined> {
  const cleaned = names.map((n) => n.trim()).filter((n) => n.length > 0)
  if (cleaned.length === 0) return undefined
  let parentId: string | undefined
  for (const n of cleaned) {
    const cat = await findOrCreateItemCategory(qbo, conn, n, parentId)
    parentId = cat.id
  }
  return parentId
}

/* ─── Item lookup by SKU (read-only — for invoice push) ─── */

export async function findItemBySku(
  qbo: QboService,
  conn: QboConnectionRow,
  sku: string,
): Promise<{ id: string; name: string } | null> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = sku.replace(/'/g, "''")
  const json = await qboFetch(
    fresh,
    `/query?query=${encodeURIComponent(`select * from Item where Sku = '${safe}'`)}`,
  )
  const item = json?.QueryResponse?.Item?.[0]
  return item ? { id: String(item.Id), name: item.Name } : null
}

/* ─── Service item find-or-create (Shipping, Discount, etc.) ─── */

/**
 * Service items don't track inventory — used for shipping, handling,
 * one-off charges. Income-only; no asset or COGS posting.
 */
export async function findOrCreateServiceItem(
  qbo: QboService,
  conn: QboConnectionRow,
  itemName: string,
  incomeAccount: AccountRef,
): Promise<{ id: string; name: string; created: boolean }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = itemName.replace(/'/g, "''")
  const found = await qboFetch(
    fresh,
    `/query?query=${encodeURIComponent(`select * from Item where Name = '${safe}'`)}`,
  )
  const existing = found?.QueryResponse?.Item?.[0]
  if (existing) {
    return { id: String(existing.Id), name: existing.Name, created: false }
  }

  const body = {
    Name: itemName,
    Type: "Service",
    IncomeAccountRef: { value: incomeAccount.id, name: incomeAccount.name },
  }
  const created = await qboFetch(fresh, `/item`, { method: "POST", body: JSON.stringify(body) })
  const item = created?.Item
  if (!item?.Id) throw new Error(`Service item create returned no Id: ${JSON.stringify(created).slice(0, 200)}`)
  return { id: String(item.Id), name: item.Name, created: true }
}

/* ─── Invoice creation ─── */

export type InvoiceLine = {
  itemId: string
  itemName?: string
  qty: number
  unitPrice: number              // dollars, already discounted (post Medusa promo)
  description?: string
}

export async function createInvoice(
  qbo: QboService,
  conn: QboConnectionRow,
  args: {
    customerId: string
    txnDate: string                // YYYY-MM-DD (fulfillment date)
    docNumber?: string             // Medusa order display id (truncated to 21 chars)
    lines: InvoiceLine[]
    shippingTotal?: number         // adds a separate ItemBasedSalesItemLine for shipping
    shippingItemId?: string        // QBO Item id for the Shipping line (skipped if omitted)
    salesTermId?: string | null    // Net 15 / Net 30 etc. — sets DueDate via QBO rules
    privateNote?: string
    /* Mark all lines tax-exempt. For B2B-only this should always be true.
     * Sets the line's TaxCodeRef to "NON". */
    taxExempt?: boolean
  },
): Promise<{ id: string; docNumber: string | null; totalAmt: number; balance: number }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const taxCodeRef = args.taxExempt ? { value: "NON" } : undefined

  const itemLines = args.lines.map((l, i) => ({
    Id: String(i + 1),
    DetailType: "SalesItemLineDetail",
    Amount: round2(l.qty * l.unitPrice),
    Description: l.description ?? "",
    SalesItemLineDetail: {
      ItemRef: { value: l.itemId, name: l.itemName },
      Qty: l.qty,
      UnitPrice: l.unitPrice,
      ...(taxCodeRef ? { TaxCodeRef: taxCodeRef } : {}),
    },
  }))

  /* Shipping is a separate line referencing a Shipping item — keeps it
   * out of inventory accounts and visible on the Invoice. If no shipping
   * item id was provided, skip the line and just embed it in privateNote
   * so the operator knows it was charged. */
  const Line: any[] = [...itemLines]
  if (args.shippingTotal && args.shippingItemId) {
    Line.push({
      Id: String(itemLines.length + 1),
      DetailType: "SalesItemLineDetail",
      Amount: round2(args.shippingTotal),
      Description: "Shipping",
      SalesItemLineDetail: {
        ItemRef: { value: args.shippingItemId, name: "Shipping" },
        Qty: 1,
        UnitPrice: round2(args.shippingTotal),
        ...(taxCodeRef ? { TaxCodeRef: taxCodeRef } : {}),
      },
    })
  }

  const body: any = {
    CustomerRef: { value: args.customerId },
    TxnDate: args.txnDate,
    Line,
  }
  if (args.docNumber) body.DocNumber = args.docNumber.slice(0, 21)
  if (args.salesTermId) body.SalesTermRef = { value: args.salesTermId }
  if (args.privateNote) body.PrivateNote = args.privateNote.slice(0, 4000)
  /* GlobalTaxCalculation: TaxExcluded keeps total = sum(lines) — no
   * auto tax overlay (per user: tax exempt across the board). */
  if (args.taxExempt) body.GlobalTaxCalculation = "TaxExcluded"

  const created = await qboFetch(fresh, `/invoice`, { method: "POST", body: JSON.stringify(body) })
  const inv = created?.Invoice
  if (!inv?.Id) throw new Error(`Invoice create returned no Id: ${JSON.stringify(created).slice(0, 400)}`)
  return {
    id: String(inv.Id),
    docNumber: inv.DocNumber ?? null,
    totalAmt: Number(inv.TotalAmt ?? 0),
    balance: Number(inv.Balance ?? 0),
  }
}

export function invoicePublicUrl(environment: string, realmId: string, invoiceId: string): string {
  return environment === "production"
    ? `https://app.qbo.intuit.com/app/invoice?txnId=${invoiceId}`
    : `https://app.sandbox.qbo.intuit.com/app/invoice?txnId=${invoiceId}`
}

/* ─── Payment creation (closes an Invoice for KAJA-paid orders) ─── */

export async function createPayment(
  qbo: QboService,
  conn: QboConnectionRow,
  args: {
    customerId: string
    invoiceId: string
    amount: number               // should equal Invoice.TotalAmt to fully close it
    txnDate: string              // YYYY-MM-DD
    /* QBO PaymentMethod Id — default "Credit Card" usually has Id 1 in
     * standard sandbox; we look it up by name to be safe. */
    paymentMethodId?: string
    /* External reference number — KAJA's transaction id when available. */
    refNum?: string
    privateNote?: string
  },
): Promise<{ id: string; totalAmt: number }> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const body: any = {
    CustomerRef: { value: args.customerId },
    TotalAmt: round2(args.amount),
    TxnDate: args.txnDate,
    Line: [{
      Amount: round2(args.amount),
      LinkedTxn: [{ TxnId: args.invoiceId, TxnType: "Invoice" }],
    }],
  }
  if (args.paymentMethodId) body.PaymentMethodRef = { value: args.paymentMethodId }
  if (args.refNum) body.PaymentRefNum = args.refNum.slice(0, 21)
  if (args.privateNote) body.PrivateNote = args.privateNote.slice(0, 4000)

  const created = await qboFetch(fresh, `/payment`, { method: "POST", body: JSON.stringify(body) })
  const pay = created?.Payment
  if (!pay?.Id) throw new Error(`Payment create returned no Id: ${JSON.stringify(created).slice(0, 200)}`)
  return { id: String(pay.Id), totalAmt: Number(pay.TotalAmt ?? 0) }
}

export async function findPaymentMethodIdByName(
  qbo: QboService,
  conn: QboConnectionRow,
  name: string,
): Promise<string | null> {
  const fresh = await ensureFreshAccessToken(qbo, conn)
  const safe = name.replace(/'/g, "''")
  const json = await qboFetch(
    fresh,
    `/query?query=${encodeURIComponent(`select * from PaymentMethod where Name = '${safe}'`)}`,
  )
  const m = json?.QueryResponse?.PaymentMethod?.[0]
  return m ? String(m.Id) : null
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

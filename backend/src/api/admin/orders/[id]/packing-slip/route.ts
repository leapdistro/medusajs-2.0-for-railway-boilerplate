import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { loadCategoryTree, productPath } from "../../../../../lib/category-tree"

/**
 * GET /admin/orders/:id/packing-slip
 *
 * A printable packing slip for the order: ship-to, then every item with
 * its size, category, tier and quantity. No prices or SKUs. Opens the print
 * dialog on load.
 *
 * Quantities are the order's current ones (after edits); lines edited
 * down to 0 are left out. Category and tier come from the product's
 * category path: the level with a `tier_key` (else the third level, for
 * older trees without one) is the tier, the levels above it the category.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id", "display_id", "created_at", "email",
      "customer.company_name", "customer.metadata",
      "shipping_address.first_name", "shipping_address.last_name", "shipping_address.company",
      "shipping_address.address_1", "shipping_address.address_2", "shipping_address.city",
      "shipping_address.province", "shipping_address.postal_code", "shipping_address.phone",
      "shipping_methods.name",
      "items.id", "items.quantity", "items.detail.quantity", "items.product_id",
      "items.product_title", "items.title", "items.variant_title",
    ],
    filters: { id: orderId },
  })
  const order = (data as any[])?.[0]
  if (!order) return res.status(404).json({ message: "Order not found" })

  const tree = await loadCategoryTree(query)
  const productIds = [...new Set(((order.items ?? []) as any[]).map((i) => i.product_id).filter(Boolean))]
  const pathByProduct = new Map<string, ReturnType<typeof productPath>>()
  if (productIds.length) {
    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "categories.id"],
      filters: { id: productIds },
      withDeleted: true,
    })
    for (const p of products as any[]) {
      pathByProduct.set(p.id, productPath(tree, (p.categories ?? []).map((c: any) => c.id)))
    }
  }

  const rows = ((order.items ?? []) as any[])
    .map((i) => {
      const qty = Number(i.detail?.quantity ?? i.quantity ?? 0)
      const path = (i.product_id && pathByProduct.get(i.product_id)) || []
      let t = path.findIndex((c) => typeof c.metadata?.tier_key === "string" && c.metadata.tier_key)
      if (t < 0 && path.length >= 3) t = path.length - 1
      return {
        item: i.product_title ?? i.title ?? "",
        size: i.variant_title ?? "",
        category: (t >= 0 ? path.slice(0, t) : path).map((c) => c.name).join(" › "),
        tier: t >= 0 ? path[t].name : "",
        qty,
      }
    })
    .filter((r) => r.qty > 0)
    .sort((a, b) => a.category.localeCompare(b.category) || a.tier.localeCompare(b.tier) || a.item.localeCompare(b.item))

  const a = order.shipping_address ?? {}
  const company = a.company || order.customer?.company_name || order.customer?.metadata?.business_name || ""
  const name = [a.first_name, a.last_name].filter(Boolean).join(" ")
  const cityLine = [a.city, [a.province?.toUpperCase(), a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")
  const date = new Date(order.created_at).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" })
  const units = rows.reduce((s, r) => s + r.qty, 0)

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packing slip #${esc(order.display_id)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 13px/1.45 Inter, system-ui, -apple-system, sans-serif; color: #0A0A0A; background: #fff; padding: 32px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0A0A0A; padding-bottom: 14px; }
  .brand { font: 600 22px Georgia, serif; }
  .brand small { display: block; font: 500 9px Inter, sans-serif; letter-spacing: .3em; text-transform: uppercase; color: #4A4A45; margin-top: 2px; }
  h1 { font-size: 20px; letter-spacing: .04em; text-transform: uppercase; text-align: right; }
  .meta { text-align: right; color: #4A4A45; margin-top: 4px; }
  .cols { display: flex; gap: 48px; margin: 20px 0; }
  .label { font: 600 10px ui-monospace, Menlo, monospace; letter-spacing: .15em; text-transform: uppercase; color: #4A4A45; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { font: 600 10px ui-monospace, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; text-align: left; border-bottom: 1.5px solid #0A0A0A; padding: 6px 8px; }
  td { border-bottom: 1px solid #E5E1D6; padding: 8px; vertical-align: top; }
  td.qty, th.qty { text-align: right; font-variant-numeric: tabular-nums; width: 60px; }
  td.qty { font-weight: 700; font-size: 15px; }
  td.chk, th.chk { width: 34px; }
  .box { display: inline-block; width: 16px; height: 16px; border: 1.5px solid #0A0A0A; }
  tfoot td { border-bottom: 0; border-top: 1.5px solid #0A0A0A; font-weight: 600; }
  .sign { display: flex; gap: 48px; margin-top: 40px; }
  .sign div { flex: 1; border-top: 1px solid #0A0A0A; padding-top: 4px; color: #4A4A45; font-size: 11px; }
  .bar { margin-bottom: 20px; }
  .bar button { font: 600 13px Inter, sans-serif; padding: 8px 18px; border: 0; background: #0A0A0A; color: #fff; cursor: pointer; }
  @media print { body { padding: 0; } .bar { display: none; } @page { margin: 14mm; } tr { break-inside: avoid; } }
</style></head>
<body>
  <div class="bar"><button onclick="window.print()">Print</button></div>
  <header>
    <div class="brand">Mind Body Spirit<small>Premium Cannabis</small></div>
    <div><h1>Packing slip</h1><div class="meta">Order #${esc(order.display_id)} · ${esc(date)}</div></div>
  </header>
  <div class="cols">
    <div>
      <div class="label">Ship to</div>
      ${[company, name, a.address_1, a.address_2, cityLine, a.phone].filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join("")}
    </div>
    ${order.shipping_methods?.[0]?.name ? `<div><div class="label">Shipping</div><div>${esc(order.shipping_methods[0].name)}</div></div>` : ""}
  </div>
  <table>
    <thead><tr><th class="chk"></th><th>Item</th><th>Size</th><th>Category</th><th>Tier</th><th class="qty">Qty</th></tr></thead>
    <tbody>
      ${rows.map((r) => `<tr><td class="chk"><span class="box"></span></td><td>${esc(r.item)}</td><td>${esc(r.size)}</td><td>${esc(r.category)}</td><td>${esc(r.tier || "—")}</td><td class="qty">${r.qty}</td></tr>`).join("")}
    </tbody>
    <tfoot><tr><td></td><td colspan="4">${rows.length} line${rows.length === 1 ? "" : "s"}</td><td class="qty">${units}</td></tr></tfoot>
  </table>
  <div class="sign"><div>Packed by</div><div>Checked by</div><div>Date</div></div>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print() }, 150) })</script>
</body></html>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.send(html)
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

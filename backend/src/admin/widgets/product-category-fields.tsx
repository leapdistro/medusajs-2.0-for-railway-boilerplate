import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * Product detail widget — "Category fields".
 *
 * Shows the extra product fields defined by the product's categories
 * (category Storefront display → "Extra product fields"), top-level
 * category first; a lower category's field with the same key wins.
 * Values live in product.metadata.custom_fields and show on the
 * storefront product page as specs. Hidden when no category defines any.
 *
 * Medusa replaces product metadata wholesale on update, so the save
 * re-reads it and changes only custom_fields.
 */

type ProductField = { key: string; label: string; unit?: string }
type Cat = { id: string; parent_category_id: string | null; metadata: Record<string, unknown> | null }

function fieldsFor(categoryIds: string[], cats: Cat[]): ProductField[] {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const pathOf = (id: string) => {
    const out: Cat[] = []
    for (let n = byId.get(id); n && out.length < 20; n = n.parent_category_id ? byId.get(n.parent_category_id) : undefined) out.unshift(n)
    return out
  }
  /* The deepest assignment's path, as on the storefront. */
  const path = categoryIds.map(pathOf).sort((a, b) => b.length - a.length)[0] ?? []
  const merged = new Map<string, ProductField>()
  for (const c of path) {
    const list = c.metadata?.productFields
    if (!Array.isArray(list)) continue
    for (const f of list) {
      if (f && typeof f.key === "string" && typeof f.label === "string") merged.set(f.key, f)
    }
  }
  return [...merged.values()]
}

const ProductCategoryFieldsWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const [fields, setFields] = useState<ProductField[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let off = false
    Promise.all([
      fetch(`/admin/products/${data.id}?fields=categories.id,metadata`, { credentials: "include" }).then((r) => r.json()),
      fetch(`/admin/product-categories?limit=1000&fields=id,parent_category_id,metadata`, { credentials: "include" }).then((r) => r.json()),
    ])
      .then(([p, c]) => {
        if (off) return
        const ids = ((p.product?.categories ?? []) as { id: string }[]).map((x) => x.id)
        setFields(fieldsFor(ids, (c.product_categories ?? []) as Cat[]))
        const saved = (p.product?.metadata?.custom_fields ?? {}) as Record<string, unknown>
        setValues(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, v == null ? "" : String(v)])))
      })
      .catch(() => { if (!off) setFields([]) })
    return () => { off = true }
  }, [data.id])

  if (!fields || fields.length === 0) return null

  const save = async () => {
    setSaving(true)
    try {
      const cur = await fetch(`/admin/products/${data.id}?fields=metadata`, { credentials: "include", cache: "no-store" })
      const curJson = await cur.json()
      if (!cur.ok) throw new Error(curJson?.message ?? `HTTP ${cur.status}`)
      const metadata: Record<string, unknown> = { ...(curJson.product?.metadata ?? {}) }
      /* Keep values of fields no longer defined (a category may get the
       * field back); blank clears a value. */
      const custom: Record<string, string> = { ...((metadata.custom_fields ?? {}) as Record<string, string>) }
      for (const f of fields) {
        const v = (values[f.key] ?? "").trim()
        if (v) custom[f.key] = v
        else delete custom[f.key]
      }
      metadata.custom_fields = custom
      const res = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      toast.success("Category fields saved", { description: "The site picks it up within a minute." })
    } catch (e: any) {
      toast.error("Couldn't save", { description: e?.message ?? "Network error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Category fields</Heading>
          <Text size="small" className="text-ui-fg-subtle">Extra fields from this product's categories. Filled ones show on the product page.</Text>
        </div>
        <Button size="small" variant="secondary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <Label size="small" htmlFor={`cf-${f.key}`}>{f.label}{f.unit ? ` (${f.unit})` : ""}</Label>
            <Input id={`cf-${f.key}`} size="small" value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          </div>
        ))}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default ProductCategoryFieldsWidget

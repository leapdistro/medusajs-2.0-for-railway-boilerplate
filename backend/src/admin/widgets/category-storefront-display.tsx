import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"
import { Button, Checkbox, Container, Heading, Input, Label, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * Category detail widget — "Storefront display".
 *
 * Edits the category.metadata keys the storefront reads for this
 * category (mbs-storefront src/lib/categories.ts): its tile (image,
 * colour, order, small lines), its intro copy, whether its children
 * get a home-page section, and how the products under it behave. A new
 * category is set up here, with no code change.
 *
 * Product settings apply to every category below this one; the nearest
 * level that sets a key wins (Flower → CBD → Classic).
 *
 * Medusa replaces a category's metadata wholesale on update, so the
 * save re-reads the current metadata and changes only these keys;
 * other keys (tier_key, variants, …) are kept.
 */

/* Tile colours the storefront has styles for (globals.css). */
const ACCENTS: { value: string; label: string }[] = [
  { value: "tier-classic", label: "Classic tier (grey)" },
  { value: "tier-exotic", label: "Exotic tier (green)" },
  { value: "tier-super", label: "Super tier (red)" },
  { value: "tier-snow", label: "Snowcaps tier (pink)" },
  { value: "tier-rapper", label: "Rapper tier (purple)" },
  { value: "accent-red", label: "Red" },
  { value: "accent-purple", label: "Purple" },
  { value: "accent-copper", label: "Copper" },
]
const NONE = "__none"

/* Product cannabinoid. The storefront picks the % field, filter and
 * label rows from it. */
const CANNABINOIDS: { value: string; label: string }[] = [
  { value: "cbd", label: "CBD" },
  { value: "cbg", label: "CBG" },
  { value: "thc-a", label: "THC-A" },
  { value: "thc-p", label: "THC-P" },
]

type Field = { key: string; label: string; hint?: string; kind: "text" | "number" | "textarea" }

const TILE_FIELDS: Field[] = [
  { key: "tileImage", label: "Tile image", hint: "Path or URL. Blank: /images/<top category>/<handle>.png", kind: "text" },
  { key: "sortOrder", label: "Sort order", hint: "Lower first. Blank: Medusa's order.", kind: "number" },
  { key: "tileMeta", label: "Tile line", hint: "Small line above the name on the home page, e.g. 30 pre-rolls per box", kind: "text" },
  { key: "tileRetail", label: "Retail value", hint: "Shown as \"Retail …\" on the home tile, e.g. 2/$10", kind: "text" },
  { key: "intro", label: "Intro", hint: "Shown on the category page. Blank: a generic line.", kind: "textarea" },
]

const HOME_FIELDS: Field[] = [
  { key: "homeOrder", label: "Home page position", hint: "Set a number to give this category's children a home-page section (1 = first). Blank: none.", kind: "number" },
  { key: "homeEyebrow", label: "Eyebrow", hint: "Small label above the title. Blank: the category name.", kind: "text" },
  { key: "homeTitle", label: "Title", hint: "{count} = number of tiles, {s} = \"s\" unless one. Blank: the category name.", kind: "text" },
  { key: "homeTitleAccent", label: "Title word in red", kind: "text" },
  { key: "homeSubtitle", label: "Subtitle", hint: "{names} = the tiles' names joined with \"and\".", kind: "text" },
  { key: "homePriceUnit", label: "Price unit", hint: "Shown after the price: qp → From $200/qp", kind: "text" },
  { key: "homeShopAllHref", label: "Shop All link", hint: "Adds a Shop All tile linking here, e.g. /products?cannabinoid=cbd", kind: "text" },
]

const PRODUCT_FIELDS: Field[] = [
  { key: "productMeta", label: "Product card line", hint: "Small line on each product card, e.g. Pre-Rolls · 30/box · 1.5g each. Blank: the top category's name.", kind: "text" },
  { key: "filterLabel", label: "Filter name", hint: "Name of the subcategory filter on the shop page, e.g. Tier. Blank: Type.", kind: "text" },
  { key: "seoTitle", label: "Page title", hint: "Browser/Google title of this category's page. Blank: built from the category names.", kind: "text" },
]

const ALL_KEYS = [...TILE_FIELDS, ...HOME_FIELDS, ...PRODUCT_FIELDS].map((f) => f.key)
const NUMBER_KEYS = new Set([...TILE_FIELDS, ...HOME_FIELDS].filter((f) => f.kind === "number").map((f) => f.key))

type Form = Record<string, string> & { accent: string; cannabinoid: string }

/* Extra product fields this category adds (e.g. "mg per piece" for
 * edibles). Products below the category fill them in on their own page
 * ("Category fields"); the storefront lists filled ones as specs. The key
 * is fixed when a field is added, so renaming the label keeps values. */
type ProductField = { key: string; label: string; unit?: string; /** added since the last save: key follows the name */ fresh?: boolean }

function readFields(v: unknown): ProductField[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((f) => f && typeof f.key === "string" && typeof f.label === "string")
    .map((f) => ({ key: f.key, label: f.label, ...(typeof f.unit === "string" && f.unit ? { unit: f.unit } : {}) }))
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

/* labels is three-way: set true, set false (stops it inheriting), or unset. */
type Labels = "inherit" | "yes" | "no"

function formFrom(meta: Record<string, unknown> | null | undefined): { form: Form; comingSoon: boolean; labels: Labels } {
  const m = meta ?? {}
  const form: Form = {
    accent: typeof m.accent === "string" && m.accent ? m.accent : NONE,
    cannabinoid: typeof m.cannabinoid === "string" && m.cannabinoid ? m.cannabinoid : NONE,
  }
  for (const k of ALL_KEYS) form[k] = m[k] == null ? "" : String(m[k])
  return { form, comingSoon: m.comingSoon === true, labels: m.labels === true ? "yes" : m.labels === false ? "no" : "inherit" }
}

const CategoryStorefrontDisplayWidget = ({ data }: DetailWidgetProps<AdminProductCategory>) => {
  const initial = formFrom(data.metadata as Record<string, unknown> | null)
  const [form, setForm] = useState<Form>(initial.form)
  const [comingSoon, setComingSoon] = useState(initial.comingSoon)
  const [labels, setLabels] = useState<Labels>(initial.labels)
  const [fields, setFields] = useState<ProductField[]>(readFields((data.metadata as any)?.productFields))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const next = formFrom(data.metadata as Record<string, unknown> | null)
    setForm(next.form)
    setComingSoon(next.comingSoon)
    setLabels(next.labels)
    setFields(readFields((data.metadata as any)?.productFields))
  }, [data.id])

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }))

  const fieldKeys = fields.map((f) => f.key)
  const badFields = fields.some((f) => !f.label.trim() || !f.key) || new Set(fieldKeys).size !== fieldKeys.length
  const bad = [...NUMBER_KEYS].filter((k) => form[k].trim() && !Number.isFinite(Number(form[k])))
  const setField = (i: number, patch: Partial<ProductField>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))

  const save = async () => {
    if (bad.length > 0 || badFields) return
    setSaving(true)
    try {
      /* Fresh read, so keys saved elsewhere since the page loaded survive. */
      const cur = await fetch(`/admin/product-categories/${data.id}?fields=metadata`, { credentials: "include", cache: "no-store" })
      const curJson = await cur.json()
      if (!cur.ok) throw new Error(curJson?.message ?? `HTTP ${cur.status}`)
      const metadata: Record<string, unknown> = { ...(curJson.product_category?.metadata ?? {}) }
      for (const k of ALL_KEYS) {
        const v = form[k].trim()
        if (!v) delete metadata[k]
        else metadata[k] = NUMBER_KEYS.has(k) ? Number(v) : v
      }
      if (form.accent === NONE) delete metadata.accent
      else metadata.accent = form.accent
      if (comingSoon) metadata.comingSoon = true
      else delete metadata.comingSoon
      if (form.cannabinoid === NONE) delete metadata.cannabinoid
      else metadata.cannabinoid = form.cannabinoid
      if (labels === "inherit") delete metadata.labels
      else metadata.labels = labels === "yes"
      const cleanFields = fields.map((f) => ({ key: f.key, label: f.label.trim(), ...(f.unit?.trim() ? { unit: f.unit.trim() } : {}) }))
      if (cleanFields.length > 0) metadata.productFields = cleanFields
      else delete metadata.productFields

      const res = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      setFields((fs) => fs.map(({ fresh: _fresh, ...f }) => f))
      toast.success("Storefront display saved", { description: "The site picks it up within a minute." })
    } catch (e: any) {
      toast.error("Couldn't save", { description: e?.message ?? "Network error" })
    } finally {
      setSaving(false)
    }
  }

  const renderField = (f: Field) => (
    <div key={f.key} className="flex flex-col gap-1">
      <Label size="small" htmlFor={`sf-${f.key}`}>{f.label}</Label>
      {f.kind === "textarea"
        ? <Textarea id={`sf-${f.key}`} value={form[f.key]} onChange={(e) => set(f.key, e.target.value)} rows={2} />
        : <Input id={`sf-${f.key}`} size="small" value={form[f.key]} onChange={(e) => set(f.key, e.target.value)}
            inputMode={f.kind === "number" ? "numeric" : undefined} />}
      {f.hint && <Text size="xsmall" className="text-ui-fg-subtle">{f.hint}</Text>}
      {bad.includes(f.key) && <Text size="xsmall" style={{ color: "#B91C1C" }}>Enter a number, or leave it blank.</Text>}
    </div>
  )

  /* A saved accent that isn't in the list still shows, so saving doesn't drop it. */
  const accentOptions = form.accent !== NONE && !ACCENTS.some((a) => a.value === form.accent)
    ? [...ACCENTS, { value: form.accent, label: form.accent }]
    : ACCENTS

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Storefront display</Heading>
          <Text size="small" className="text-ui-fg-subtle">How this category looks on hempmbs.com.</Text>
        </div>
        <Button size="small" variant="secondary" disabled={saving || bad.length > 0 || badFields} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label size="small">Tile colour</Label>
          <Select value={form.accent} onValueChange={(v) => set("accent", v)}>
            <Select.Trigger><Select.Value /></Select.Trigger>
            <Select.Content>
              <Select.Item value={NONE}>None (black)</Select.Item>
              {accentOptions.map((a) => <Select.Item key={a.value} value={a.value}>{a.label}</Select.Item>)}
            </Select.Content>
          </Select>
        </div>
        {TILE_FIELDS.map(renderField)}
        <div className="flex items-center gap-2">
          <Checkbox id="sf-coming-soon" checked={comingSoon} onCheckedChange={(v) => setComingSoon(v === true)} />
          <Label size="small" htmlFor="sf-coming-soon">Coming soon (tile dimmed, not clickable)</Label>
        </div>
      </div>
      <div className="flex flex-col gap-4 px-6 py-4">
        <Text size="small" weight="plus">Home page section</Text>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{HOME_FIELDS.map(renderField)}</div>
      </div>
      <div className="flex flex-col gap-4 px-6 py-4">
        <div>
          <Text size="small" weight="plus">Products in this category</Text>
          <Text size="xsmall" className="text-ui-fg-subtle">Applies to every category below this one too. A lower category's setting wins.</Text>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label size="small">Cannabinoid</Label>
            <Select value={form.cannabinoid} onValueChange={(v) => set("cannabinoid", v)}>
              <Select.Trigger><Select.Value /></Select.Trigger>
              <Select.Content>
                <Select.Item value={NONE}>Same as the category above</Select.Item>
                {CANNABINOIDS.map((c) => <Select.Item key={c.value} value={c.value}>{c.label}</Select.Item>)}
              </Select.Content>
            </Select>
            <Text size="xsmall" className="text-ui-fg-subtle">Picks the % shown on products, the cannabinoid filter and the label figures.</Text>
          </div>
          <div className="flex flex-col gap-1">
            <Label size="small">Shelf labels</Label>
            <Select value={labels} onValueChange={(v) => setLabels(v as Labels)}>
              <Select.Trigger><Select.Value /></Select.Trigger>
              <Select.Content>
                <Select.Item value="inherit">Same as the category above</Select.Item>
                <Select.Item value="yes">Products can print labels</Select.Item>
                <Select.Item value="no">No labels</Select.Item>
              </Select.Content>
            </Select>
            <Text size="xsmall" className="text-ui-fg-subtle">Only buyers with labels switched on see the print buttons.</Text>
          </div>
          {PRODUCT_FIELDS.map(renderField)}
        </div>
        <div className="flex flex-col gap-2">
          <div>
            <Label size="small">Extra product fields</Label>
            <Text size="xsmall" className="text-ui-fg-subtle">Fields every product below this category gets on its page (e.g. "Per piece", unit "mg"). Filled ones show on the storefront as specs.</Text>
          </div>
          {fields.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input size="small" placeholder="Field name" value={f.label}
                onChange={(e) => setField(i, f.fresh ? { label: e.target.value, key: slug(e.target.value) } : { label: e.target.value })} />
              <Input size="small" placeholder="Unit (optional)" className="w-40" value={f.unit ?? ""} onChange={(e) => setField(i, { unit: e.target.value })} />
              <Button size="small" variant="transparent" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          {badFields && <Text size="xsmall" style={{ color: "#B91C1C" }}>Each field needs a name, and names must differ.</Text>}
          <div>
            <Button size="small" variant="secondary" onClick={() => setFields((fs) => [...fs, { key: "", label: "", fresh: true }])}>Add field</Button>
          </div>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
})

export default CategoryStorefrontDisplayWidget

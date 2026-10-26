import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProductCategory } from "@medusajs/framework/types"
import { Button, Checkbox, Container, Heading, Input, Label, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

/**
 * Category detail widget — "Storefront display".
 *
 * Edits the category.metadata keys the storefront reads for this
 * category (mbs-storefront src/lib/categories.ts): its tile (image,
 * colour, order, small lines), its intro copy, and whether its
 * children get a home-page section. A new category is set up here,
 * with no code change.
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

const ALL_KEYS = [...TILE_FIELDS, ...HOME_FIELDS].map((f) => f.key)
const NUMBER_KEYS = new Set([...TILE_FIELDS, ...HOME_FIELDS].filter((f) => f.kind === "number").map((f) => f.key))

type Form = Record<string, string> & { accent: string }

function formFrom(meta: Record<string, unknown> | null | undefined): { form: Form; comingSoon: boolean } {
  const m = meta ?? {}
  const form: Form = { accent: typeof m.accent === "string" && m.accent ? m.accent : NONE }
  for (const k of ALL_KEYS) form[k] = m[k] == null ? "" : String(m[k])
  return { form, comingSoon: m.comingSoon === true }
}

const CategoryStorefrontDisplayWidget = ({ data }: DetailWidgetProps<AdminProductCategory>) => {
  const initial = formFrom(data.metadata as Record<string, unknown> | null)
  const [form, setForm] = useState<Form>(initial.form)
  const [comingSoon, setComingSoon] = useState(initial.comingSoon)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const next = formFrom(data.metadata as Record<string, unknown> | null)
    setForm(next.form)
    setComingSoon(next.comingSoon)
  }, [data.id])

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }))

  const bad = [...NUMBER_KEYS].filter((k) => form[k].trim() && !Number.isFinite(Number(form[k])))

  const save = async () => {
    if (bad.length > 0) return
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

      const res = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
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
        <Button size="small" variant="secondary" disabled={saving || bad.length > 0} onClick={save}>
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
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
})

export default CategoryStorefrontDisplayWidget

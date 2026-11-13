import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminCollection, DetailWidgetProps } from "@medusajs/framework/types"
import { Button, Checkbox, Container, Heading, Input, Label, Text, Textarea, toast } from "@medusajs/ui"
import { useEffect, useRef, useState } from "react"
import { brandShades, isBrandColor, type BrandMeta } from "../../lib/brand"

/**
 * Collection detail widget — "Storefront display" for a brand.
 *
 * A third-party brand is a collection (lib/brand.ts): its products are
 * the ones with this collection in their Organize section. This edits
 * the collection.metadata keys the storefront reads: the brand colour
 * (the site derives the tier-style tint and edge from it), logo,
 * description and the authorized-retailer stamp. The preview uses the
 * same shades as the site.
 *
 * Medusa replaces metadata wholesale on update, so the save re-reads the
 * current metadata and changes only these keys.
 */

const KEYS = ["color", "description", "logo", "authorized"] as const

type Form = { color: string; description: string; logo: string; authorized: boolean }

function formFrom(meta: Record<string, unknown> | null | undefined): Form {
  const m = (meta ?? {}) as BrandMeta
  return {
    color: isBrandColor(m.color) ? m.color.toUpperCase() : "",
    description: typeof m.description === "string" ? m.description : "",
    logo: typeof m.logo === "string" ? m.logo : "",
    authorized: m.authorized === true,
  }
}

/* Storefront token values, for the preview only (globals.css). */
const INK = "#171B14"
const PAPER = "#FFF9ED"
const CARD = "#FFFDF7"

const CollectionBrandDisplayWidget = ({ data }: DetailWidgetProps<AdminCollection>) => {
  const [form, setForm] = useState<Form>(formFrom(data.metadata))
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const logoInput = useRef<HTMLInputElement>(null)

  useEffect(() => { setForm(formFrom(data.metadata)) }, [data.id])

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  /* The hex box takes "e4002b", "#E4002B" or blank. */
  const hex = form.color.trim() ? (form.color.trim().startsWith("#") ? form.color.trim() : `#${form.color.trim()}`) : ""
  const badColor = hex !== "" && !isBrandColor(hex)
  const shades = isBrandColor(hex) ? brandShades(hex) : null

  const uploadLogo = async (file: File) => {
    setUploading(true)
    try {
      const body = new FormData()
      body.append("files", file)
      const res = await fetch("/admin/uploads", { method: "POST", credentials: "include", body })
      const json = await res.json().catch(() => ({}))
      const url = json?.files?.[0]?.url
      if (!res.ok || !url) throw new Error(json?.message ?? `Upload failed (${res.status})`)
      set("logo", url)
      toast.success("Logo uploaded", { description: "Save to use it on the site." })
    } catch (e: any) {
      toast.error("Couldn't upload the logo", { description: e?.message ?? "Network error" })
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    if (badColor) return
    setSaving(true)
    try {
      /* Fresh read, so keys saved elsewhere since the page loaded survive. */
      const cur = await fetch(`/admin/collections/${data.id}?fields=metadata`, { credentials: "include", cache: "no-store" })
      const curJson = await cur.json()
      if (!cur.ok) throw new Error(curJson?.message ?? `HTTP ${cur.status}`)
      const metadata: Record<string, unknown> = { ...(curJson.collection?.metadata ?? {}) }
      for (const k of KEYS) delete metadata[k]
      if (hex) metadata.color = hex.toUpperCase()
      if (form.description.trim()) metadata.description = form.description.trim()
      if (form.logo) metadata.logo = form.logo
      if (form.authorized) metadata.authorized = true

      const res = await fetch(`/admin/collections/${data.id}`, {
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

  const surface = shades?.surface ?? "#E7E7E1"
  const edge = shades?.edge ?? "#A3A59D"
  const swatch = shades?.swatch ?? "#8E918A"

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Storefront display</Heading>
          <Text size="small" className="text-ui-fg-subtle">How this brand looks on hempmbs.com. Its products are the ones with this collection.</Text>
        </div>
        <Button size="small" variant="secondary" disabled={saving || uploading || badColor} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label size="small" htmlFor="brand-color">Brand colour</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick the brand colour"
              value={isBrandColor(hex) ? hex : "#8E918A"}
              onChange={(e) => set("color", e.target.value.toUpperCase())}
              style={{ width: 40, height: 32, padding: 0, border: "1px solid var(--border-base)", borderRadius: 6, background: "none", cursor: "pointer" }}
            />
            <Input id="brand-color" size="small" placeholder="#E4002B" value={form.color} onChange={(e) => set("color", e.target.value)} />
            {form.color && <Button size="small" variant="transparent" onClick={() => set("color", "")}>Clear</Button>}
          </div>
          <Text size="xsmall" className="text-ui-fg-subtle">The brand's main colour. The site makes the light tint and the card edge from it, the way tiers look. It's never used for text or buttons.</Text>
          {badColor && <Text size="xsmall" style={{ color: "#B91C1C" }}>Enter a colour like #E4002B, or leave it blank.</Text>}
        </div>

        <div className="flex flex-col gap-1">
          <Label size="small">Logo</Label>
          <div className="flex items-center gap-3">
            {form.logo && (
              <div style={{ background: surface, border: `1px solid ${INK}`, borderRadius: 6, padding: 6, height: 48, minWidth: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src={form.logo} alt="" style={{ maxHeight: 36, maxWidth: 140, objectFit: "contain" }} />
              </div>
            )}
            <Button size="small" variant="secondary" disabled={uploading} onClick={() => logoInput.current?.click()}>
              {uploading ? "Uploading…" : form.logo ? "Replace" : "Upload logo"}
            </Button>
            {form.logo && <Button size="small" variant="transparent" onClick={() => set("logo", "")}>Remove</Button>}
            <input ref={logoInput} type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadLogo(f) }} />
          </div>
          <Text size="xsmall" className="text-ui-fg-subtle">Only once we're authorized to use it. A PNG with a transparent background, or an SVG, looks best.</Text>
        </div>

        <div className="flex flex-col gap-1 md:col-span-2">
          <Label size="small" htmlFor="brand-description">Description</Label>
          <Textarea id="brand-description" rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
          <Text size="xsmall" className="text-ui-fg-subtle">Shown under the brand's name on its page. Blank: no line.</Text>
        </div>

        <div className="flex items-center gap-2 md:col-span-2">
          <Checkbox id="brand-authorized" checked={form.authorized} onCheckedChange={(v) => set("authorized", v === true)} />
          <Label size="small" htmlFor="brand-authorized">We're an authorized retailer (shows an "Authorized retailer" stamp on the brand page)</Label>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-6 py-4">
        <div>
          <Text size="small" weight="plus">Preview</Text>
          <Text size="xsmall" className="text-ui-fg-subtle">
            {shades ? `Tint ${shades.surface} · edge ${shades.edge}` : "No colour yet: the brand uses the plain grey look."}
          </Text>
        </div>
        <div className="flex flex-wrap items-start gap-6" style={{ background: PAPER, borderRadius: 8, padding: 16 }}>
          {/* Brand page header */}
          <div style={{ background: surface, borderRadius: 7, padding: "18px 20px", minWidth: 240, flex: "1 1 260px", color: INK }}>
            {form.logo && <img src={form.logo} alt="" style={{ maxHeight: 32, maxWidth: 160, objectFit: "contain", marginBottom: 8, display: "block" }} />}
            <div style={{ fontFamily: "Georgia, serif", fontWeight: 800, fontSize: 28, letterSpacing: "-0.04em", lineHeight: 1 }}>{data.title}</div>
            {form.description.trim() && <div style={{ fontSize: 13, marginTop: 6, opacity: 0.8 }}>{form.description.trim()}</div>}
            {form.authorized && (
              <div style={{ display: "inline-block", marginTop: 10, fontSize: 11, fontWeight: 700, border: `1.5px solid ${INK}`, borderRadius: 999, padding: "2px 10px", background: CARD }}>
                Authorized retailer
              </div>
            )}
          </div>
          {/* Product card */}
          <div style={{ width: 170, background: CARD, border: `1.5px solid ${INK}`, borderRadius: 7, boxShadow: `5px 5px 0 0 ${edge}, 5px 5px 0 1.5px ${INK}`, overflow: "hidden", color: INK }}>
            <div style={{ background: surface, height: 120, padding: 8, borderBottom: `1.5px solid ${INK}` }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: CARD, border: `1.5px solid ${INK}`, borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 700 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, border: `1.5px solid ${INK}`, background: swatch }} />
                {data.title}
              </span>
            </div>
            <div style={{ padding: "8px 10px", fontSize: 13, fontWeight: 700 }}>Product name</div>
          </div>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product_collection.details.after",
})

export default CollectionBrandDisplayWidget

import { Button, Input, Label, Switch, Text, Textarea, toast } from "@medusajs/ui"
import { useState } from "react"
import { uid, uploadImage, type Block } from "./api"
import { PickedProducts, ProductPicker } from "./product-picker"

/**
 * The email's content as a list of blocks. Each block only offers words,
 * links, products and pictures: colours, fonts and layout come from the
 * email renderer (lib/marketing/email.tsx), so nothing can go off-brand.
 */

const LABEL: Record<Block["type"], string> = {
  heading: "Heading", text: "Text", products: "Products", button: "Button", image: "Image", promise: "Promise", spacer: "Space",
}

export function newBlock(type: Block["type"]): Block {
  switch (type) {
    case "heading": return { id: uid(), type, text: "", highlight: "" }
    case "text": return { id: uid(), type, text: "" }
    case "products": return { id: uid(), type, title: "", productIds: [], layout: "grid", showPrices: true }
    case "button": return { id: uid(), type, label: "Shop now", url: "/products" }
    case "image": return { id: uid(), type, url: "", alt: "" }
    case "spacer": return { id: uid(), type, size: "m" }
    case "promise": return { id: uid(), type, intro: "products that increase:", items: ["Store Traffic", "Repeat Customers", "Shelf Appeal"] }
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label size="xsmall" weight="plus">{label}</Label>
      {children}
      {hint ? <Text size="xsmall" className="text-ui-fg-muted">{hint}</Text> : null}
    </div>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-ui-border-base overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 txt-compact-small ${o.value === value ? "bg-ui-bg-base-pressed text-ui-fg-base font-medium" : "bg-ui-bg-base text-ui-fg-subtle"}`}
        >{o.label}</button>
      ))}
    </div>
  )
}

function BlockForm({ block, onChange, templateMode }: { block: Block; onChange: (b: Block) => void; templateMode?: boolean }) {
  const [picking, setPicking] = useState(false)
  const [uploading, setUploading] = useState(false)
  switch (block.type) {
    case "heading":
      return (
        <div className="flex flex-col gap-3">
          <Field label="Heading"><Input value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} placeholder="Fresh drop just landed." /></Field>
          <Field label="Highlight (optional)" hint="One word or phrase from the heading, marked in butter like the site's headings.">
            <Input value={block.highlight ?? ""} onChange={(e) => onChange({ ...block, highlight: e.target.value })} placeholder="landed" />
          </Field>
        </div>
      )
    case "text":
      return (
        <Field label="Text" hint="Blank line = new paragraph. **bold**, [link text](/products). {{first_name}} and {{company}} fill in per buyer.">
          <Textarea rows={5} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
        </Field>
      )
    case "button":
      return (
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Button text"><Input value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} /></Field>
          <Field label="Link" hint="A site path like /products or a full https:// link.">
            <Input value={block.url} onChange={(e) => onChange({ ...block, url: e.target.value })} />
          </Field>
        </div>
      )
    case "image":
      return (
        <div className="flex flex-col gap-3">
          {block.url ? <img src={block.url} alt="" style={{ maxHeight: 140, borderRadius: 6, objectFit: "cover" }} /> : null}
          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (!f) return
                  setUploading(true)
                  try { onChange({ ...block, url: await uploadImage(f) }) } catch (err: any) { toast.error(err?.message ?? "Upload failed") } finally { setUploading(false) }
                }}
              />
              <span className="inline-flex items-center rounded-md border border-ui-border-base px-3 py-1 txt-compact-small">{uploading ? "Uploading…" : block.url ? "Replace picture" : "Upload picture"}</span>
            </label>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Description" hint="Read aloud and shown when images are off."><Input value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} /></Field>
            <Field label="Link (optional)"><Input value={block.link ?? ""} onChange={(e) => onChange({ ...block, link: e.target.value })} placeholder="/products" /></Field>
          </div>
        </div>
      )
    case "products":
      return (
        <div className="flex flex-col gap-3">
          {templateMode ? (
            <div className="flex flex-col gap-2 rounded-md bg-ui-bg-subtle p-2">
              <Text size="xsmall" weight="plus">Products in this block</Text>
              <Segmented
                value={block.fill ?? "pick"}
                onChange={(v) => onChange(v === "pick" ? { ...block, fill: undefined, max: undefined } : { ...block, fill: v, max: block.max ?? (v === "new" ? 8 : 4) })}
                options={[{ value: "new" as const, label: "Receiving's new" }, { value: "restock" as const, label: "Receiving's restocked" }, { value: "pick" as const, label: "I pick" }]}
              />
              {block.fill ? (
                <div className="flex items-center gap-2">
                  <Text size="small">Show up to</Text>
                  <div style={{ width: 70 }}><Input type="number" min={1} max={24} value={String(block.max ?? 8)} onChange={(e) => onChange({ ...block, max: Math.min(24, Math.max(1, Number(e.target.value) || 1)) })} /></div>
                  <Text size="small" className="text-ui-fg-subtle">picked across tiers, in stock, photos first</Text>
                </div>
              ) : null}
            </div>
          ) : null}
          <Field label="Section title (optional)"><Input value={block.title ?? ""} onChange={(e) => onChange({ ...block, title: e.target.value })} placeholder="New arrivals" /></Field>
          <div className="flex items-center gap-4 flex-wrap">
            <Segmented value={block.layout} onChange={(v) => onChange({ ...block, layout: v })} options={[{ value: "grid", label: "Two across" }, { value: "list", label: "One per row" }]} />
            <div className="flex items-center gap-2">
              <Switch checked={block.showPrices} onCheckedChange={(v) => onChange({ ...block, showPrices: v })} />
              <Text size="small">Show each buyer's price</Text>
            </div>
          </div>
          {block.fill ? (
            <Text size="small" className="text-ui-fg-subtle">Filled from each receiving when the announcement is made.</Text>
          ) : (
            <>
              <PickedProducts ids={block.productIds} onChange={(productIds) => onChange({ ...block, productIds })} />
              <div><Button size="small" variant="secondary" onClick={() => setPicking(true)}>Add products</Button></div>
            </>
          )}
          {picking ? (
            <ProductPicker selected={block.productIds} onClose={() => setPicking(false)} onDone={(productIds) => { onChange({ ...block, productIds }); setPicking(false) }} />
          ) : null}
        </div>
      )
    case "promise":
      return (
        <div className="flex flex-col gap-3">
          <Field label="Line above" hint="Small italic line, like the home page's.">
            <Input value={block.intro} onChange={(e) => onChange({ ...block, intro: e.target.value })} placeholder="products that increase:" />
          </Field>
          <Field label="Points" hint="One per line, up to 5. Each gets a tick.">
            <Textarea rows={3} value={block.items.join("\n")} onChange={(e) => onChange({ ...block, items: e.target.value.split("\n").slice(0, 5) })} />
          </Field>
        </div>
      )
    case "spacer":
      return <Segmented value={block.size} onChange={(v) => onChange({ ...block, size: v })} options={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }]} />
  }
}

export function BlockEditor({ blocks, onChange, readOnly, templateMode }: { blocks: Block[]; onChange: (b: Block[]) => void; readOnly?: boolean; templateMode?: boolean }) {
  const set = (i: number, b: Block) => onChange(blocks.map((x, j) => (j === i ? b : x)))
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= blocks.length) return
    const next = [...blocks]; [next[i], next[j]] = [next[j], next[i]]; onChange(next)
  }
  const add = (type: Block["type"], at: number) => {
    const next = [...blocks]; next.splice(at, 0, newBlock(type)); onChange(next)
  }
  return (
    <div className="flex flex-col gap-3" style={readOnly ? { pointerEvents: "none", opacity: 0.7 } : undefined}>
      {blocks.map((b, i) => (
        <div key={b.id} className="rounded-lg border border-ui-border-base bg-ui-bg-base">
          <div className="flex items-center gap-1 px-3 py-2 border-b border-ui-border-base bg-ui-bg-subtle rounded-t-lg">
            <Text size="small" weight="plus" style={{ flex: 1 }}>{LABEL[b.type]}</Text>
            <Button size="small" variant="transparent" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
            <Button size="small" variant="transparent" onClick={() => move(i, 1)} disabled={i === blocks.length - 1}>↓</Button>
            <Button size="small" variant="transparent" onClick={() => onChange(blocks.filter((_, j) => j !== i))}>Delete</Button>
          </div>
          <div className="p-3"><BlockForm block={b} onChange={(nb) => set(i, nb)} templateMode={templateMode} /></div>
        </div>
      ))}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2 items-center">
          <Text size="small" className="text-ui-fg-subtle">Add:</Text>
          {(["heading", "text", "products", "button", "image"] as Block["type"][]).map((t) => (
            <Button key={t} size="small" variant="secondary" onClick={() => add(t, blocks.length)}>{LABEL[t]}</Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

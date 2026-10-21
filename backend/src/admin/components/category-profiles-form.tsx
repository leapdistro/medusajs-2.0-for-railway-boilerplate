import { Button, Input, Label, Switch, Text, toast } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"

/**
 * MBS Settings → Categories. Edits the `category_profiles` setting
 * through /admin/mbs/category-profiles, which validates the whole list
 * before writing (lib/profile-store.ts).
 *
 * One card per category: where its products live in Medusa, how it's
 * received (units, sizes, required fields), and which price table its
 * default prices come from. Sub-categories that exist in Medusa are
 * picked up automatically; the Sub-categories list here is only for
 * ones that need their own label or sizes.
 */

type Size = {
  sizeKey: string
  label: string
  multiplier: number | string
  grams?: number | string
  unitLabel?: string
  unitsPerVariant?: number | string
}
type Sub = { key: string; medusaName: string; label: string; variants?: Size[] }
type Unit = { singular: string; plural: string }
type Fields = {
  strainType: boolean
  bestFor: boolean
  effects: boolean
  cannabinoids: boolean
  coaRequired: boolean
  upc: boolean
}
type Profile = {
  key: string
  displayName: string
  parentCategoryName: string
  subcategoryParentHandle?: string
  subcategories: Sub[]
  variants: Size[]
  fields: Fields
  pricingModel: "tier" | "flat"
  tierPricesSettingKey?: string
  unitLabel: Unit
  inputUnitLabel: Unit
  inputToPoolMultiplier: number | string
  qboCategoryBranch?: string
  archived?: boolean
}
type Category = { id: string; name: string; handle: string; parent_category_id: string | null }

const FIELD_LABELS: Array<[keyof Fields, string]> = [
  ["strainType", "Strain type (Indica / Sativa / Hybrid)"],
  ["bestFor", "Best for (day / evening / night)"],
  ["effects", "Effects"],
  ["cannabinoids", "Cannabinoid %"],
  ["coaRequired", "COA required"],
  ["upc", "UPC barcode"],
]

const blankProfile = (): Profile => ({
  key: "",
  displayName: "",
  parentCategoryName: "",
  subcategories: [],
  variants: [{ sizeKey: "unit", label: "Unit", multiplier: 1 }],
  fields: { strainType: false, bestFor: false, effects: false, cannabinoids: false, coaRequired: false, upc: true },
  pricingModel: "tier",
  tierPricesSettingKey: "",
  unitLabel: { singular: "Unit", plural: "Units" },
  inputUnitLabel: { singular: "unit", plural: "units" },
  inputToPoolMultiplier: 1,
})

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

const selectCls = "h-8 w-full border border-ui-border-base bg-ui-bg-field px-2 text-sm rounded-md"

export const CategoryProfilesForm = () => {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())
  const [categories, setCategories] = useState<Category[]>([])
  const [source, setSource] = useState<string>("")
  const [open, setOpen] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/admin/mbs/category-profiles", { credentials: "include" })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `Load failed (${res.status})`)
      setProfiles(json.profiles ?? [])
      setSavedKeys(new Set((json.profiles ?? []).map((p: Profile) => p.key)))
      setCategories(json.categories ?? [])
      setSource(json.source ?? "")
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't load categories")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const update = (i: number, patch: Partial<Profile>) =>
    setProfiles((list) => list.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  const addProfile = () => {
    setProfiles((list) => [...list, blankProfile()])
    setOpen(profiles.length)
  }

  const save = async () => {
    setSaving(true)
    setErrors([])
    try {
      const res = await fetch("/admin/mbs/category-profiles", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErrors(json?.errors ?? [json?.message ?? `Save failed (${res.status})`])
        throw new Error("Not saved — fix the problems listed above the categories.")
      }
      setProfiles(json.profiles)
      setSavedKeys(new Set(json.profiles.map((p: Profile) => p.key)))
      setSource("settings")
      toast.success("Categories saved")
      for (const w of json.warnings ?? []) toast.warning(w)
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed")
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Text size="small" className="text-ui-fg-subtle">Loading…</Text>

  return (
    <div className="flex flex-col gap-4">
      <Text size="small" className="text-ui-fg-subtle">
        How each category is received: where its products live in Medusa, its units and sizes, the
        fields the receiving form asks for, and the price table its default prices come from.
        Sub-categories you add in Medusa appear automatically.
        {source === "built-in" && " These are the built-in setups; nothing is stored until you save."}
      </Text>

      {errors.length > 0 && (
        <div className="border border-ui-border-error rounded-md px-4 py-3 bg-ui-bg-subtle">
          <Text size="small" weight="plus" className="text-ui-fg-error">Not saved:</Text>
          {errors.map((e, i) => (
            <Text key={i} size="small" className="text-ui-fg-error">{e}</Text>
          ))}
        </div>
      )}

      {profiles.map((p, i) => (
        <div key={i} className="border border-ui-border-base rounded-md">
          <button
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <span>
              <Text size="small" weight="plus" as="span">{p.displayName || "New category"}</Text>
              <Text size="xsmall" as="span" className="text-ui-fg-subtle ml-2">{p.key}</Text>
              {p.archived && <Text size="xsmall" as="span" className="text-ui-fg-muted ml-2">· archived</Text>}
            </span>
            <Text size="xsmall" className="text-ui-fg-subtle">{open === i ? "Close" : "Edit"}</Text>
          </button>
          {open === i && (
            <ProfileEditor
              profile={p}
              isSaved={savedKeys.has(p.key)}
              categories={categories}
              onChange={(patch) => update(i, patch)}
              onRemove={() => {
                setProfiles((list) => list.filter((_, idx) => idx !== i))
                setOpen(null)
              }}
            />
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <Button variant="secondary" size="small" onClick={addProfile}>Add category</Button>
        <Button size="small" onClick={save} isLoading={saving}>Save categories</Button>
      </div>
    </div>
  )
}

const ProfileEditor = ({
  profile: p,
  isSaved,
  categories,
  onChange,
  onRemove,
}: {
  profile: Profile
  isSaved: boolean
  categories: Category[]
  onChange: (patch: Partial<Profile>) => void
  onRemove: () => void
}) => {
  const topLevel = useMemo(() => categories.filter((c) => !c.parent_category_id), [categories])
  const parent = topLevel.find((c) => c.name === p.parentCategoryName)
  /* Sub-category root options: the parent itself, or any category under it. */
  const descendants = useMemo(() => {
    if (!parent) return []
    const out: Category[] = []
    const walk = (id: string) => {
      for (const c of categories.filter((x) => x.parent_category_id === id)) {
        out.push(c)
        walk(c.id)
      }
    }
    walk(parent.id)
    return out
  }, [categories, parent])
  const root = p.subcategoryParentHandle
    ? categories.find((c) => c.handle === p.subcategoryParentHandle)
    : parent
  const liveSubs = root ? categories.filter((c) => c.parent_category_id === root.id) : []

  return (
    <div className="border-t border-ui-border-base px-4 py-4 flex flex-col gap-5">
      <Section title="Category">
        <Grid>
          <Field label="Display name">
            <Input
              size="small"
              value={p.displayName}
              onChange={(e) => onChange({ displayName: e.target.value, ...(isSaved ? {} : { key: slug(e.target.value) }) })}
            />
          </Field>
          <Field label="Key" hint={isSaved ? "Fixed once saved: receiving pages and products refer to it." : "Lowercase words joined by hyphens."}>
            <Input size="small" value={p.key} disabled={isSaved} onChange={(e) => onChange({ key: slug(e.target.value) })} />
          </Field>
          <Field label="Parent category (Medusa)">
            <select
              className={selectCls}
              value={p.parentCategoryName}
              onChange={(e) => onChange({ parentCategoryName: e.target.value, subcategoryParentHandle: undefined })}
            >
              <option value="">Choose…</option>
              {topLevel.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Sub-categories live under" hint="Use a deeper category when the parent has a level in between (Flower → CBD → Classic).">
            <select
              className={selectCls}
              value={p.subcategoryParentHandle ?? ""}
              onChange={(e) => onChange({ subcategoryParentHandle: e.target.value || undefined })}
            >
              <option value="">{p.parentCategoryName || "The parent"} itself</option>
              {descendants.map((c) => <option key={c.id} value={c.handle}>{c.name} ({c.handle})</option>)}
            </select>
          </Field>
        </Grid>
        <Text size="xsmall" className="text-ui-fg-subtle">
          Sub-categories in Medusa now: {liveSubs.length ? liveSubs.map((c) => c.name).join(", ") : "none"}
        </Text>
      </Section>

      <Section title="Units">
        <Grid>
          <Field label="Received in (singular / plural)" hint="What the receiving form's quantity counts, e.g. lb / lbs, box / boxes.">
            <Pair value={p.inputUnitLabel} onChange={(inputUnitLabel) => onChange({ inputUnitLabel })} />
          </Field>
          <Field label="Stocked in (singular / plural)" hint="The shared stock unit every size draws from, e.g. QP / QPs, Box / Boxes.">
            <Pair value={p.unitLabel} onChange={(unitLabel) => onChange({ unitLabel })} />
          </Field>
          <Field label="Stock units per received unit" hint="1 lb = 4 QPs → 4. 1 box = 1 box → 1.">
            <Input size="small" type="number" min="0" step="any" value={p.inputToPoolMultiplier}
              onChange={(e) => onChange({ inputToPoolMultiplier: e.target.value })} />
          </Field>
        </Grid>
      </Section>

      <Section title="Sizes" hint="Sizes every sub-category sells unless it sets its own below. Stock used = how many stock units one of this size takes.">
        <SizesEditor sizes={p.variants} onChange={(variants) => onChange({ variants })} />
      </Section>

      <Section title="Sub-categories with their own label or sizes" hint="Only needed when a sub-category differs, e.g. Hashholes sell 15 ct boxes while the rest sell 30 ct.">
        {p.subcategories.map((s, si) => (
          <div key={si} className="border border-ui-border-base rounded-md p-3 flex flex-col gap-3">
            <Grid>
              <Field label="Medusa category">
                <select
                  className={selectCls}
                  value={s.medusaName}
                  onChange={(e) => {
                    const subs = [...p.subcategories]
                    subs[si] = { ...s, medusaName: e.target.value, key: s.key || slug(e.target.value), label: s.label || e.target.value }
                    onChange({ subcategories: subs })
                  }}
                >
                  <option value="">Choose…</option>
                  {liveSubs.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                  {s.medusaName && !liveSubs.some((c) => c.name === s.medusaName) && (
                    <option value={s.medusaName}>{s.medusaName} (not in Medusa)</option>
                  )}
                </select>
              </Field>
              <Field label="Key" hint="Used in SKUs and price tables.">
                <Input size="small" value={s.key} onChange={(e) => {
                  const subs = [...p.subcategories]
                  subs[si] = { ...s, key: slug(e.target.value) }
                  onChange({ subcategories: subs })
                }} />
              </Field>
              <Field label="Label">
                <Input size="small" value={s.label} onChange={(e) => {
                  const subs = [...p.subcategories]
                  subs[si] = { ...s, label: e.target.value }
                  onChange({ subcategories: subs })
                }} />
              </Field>
            </Grid>
            <div className="flex items-center gap-2">
              <Switch
                checked={!!s.variants?.length}
                onCheckedChange={(on) => {
                  const subs = [...p.subcategories]
                  subs[si] = { ...s, variants: on ? [{ sizeKey: "", label: "", multiplier: 1 }] : undefined }
                  onChange({ subcategories: subs })
                }}
              />
              <Label size="xsmall">Own sizes</Label>
            </div>
            {!!s.variants?.length && (
              <SizesEditor sizes={s.variants} onChange={(variants) => {
                const subs = [...p.subcategories]
                subs[si] = { ...s, variants }
                onChange({ subcategories: subs })
              }} />
            )}
            <div>
              <Button variant="transparent" size="small" onClick={() => onChange({ subcategories: p.subcategories.filter((_, x) => x !== si) })}>
                Remove sub-category
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button variant="secondary" size="small" onClick={() => onChange({ subcategories: [...p.subcategories, { key: "", medusaName: "", label: "" }] })}>
            Add sub-category
          </Button>
        </div>
      </Section>

      <Section title="Receiving form asks for">
        <div className="grid grid-cols-2 gap-2">
          {FIELD_LABELS.map(([k, label]) => (
            <div key={k} className="flex items-center gap-2">
              <Switch checked={!!p.fields[k]} onCheckedChange={(on) => onChange({ fields: { ...p.fields, [k]: on } })} />
              <Label size="xsmall">{label}</Label>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Pricing and QuickBooks">
        <Grid>
          <Field label="Default prices from">
            <select className={selectCls} value={p.pricingModel}
              onChange={(e) => onChange({ pricingModel: e.target.value as Profile["pricingModel"] })}>
              <option value="tier">A price table (sub-category × size)</option>
              <option value="flat">A price typed on each receiving row</option>
            </select>
          </Field>
          {p.pricingModel === "tier" && (
            <Field label="Price table key" hint="Settings key holding this category's default prices, e.g. pre_roll_tier_prices.">
              <Input size="small" value={p.tierPricesSettingKey ?? ""}
                onChange={(e) => onChange({ tierPricesSettingKey: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
            </Field>
          )}
          <Field label="QuickBooks category level (optional)" hint="Inserted between the parent and the sub-category, e.g. CBD → Flower › CBD › Classic.">
            <Input size="small" value={p.qboCategoryBranch ?? ""} onChange={(e) => onChange({ qboCategoryBranch: e.target.value || undefined })} />
          </Field>
        </Grid>
      </Section>

      <div className="flex items-center justify-between border-t border-ui-border-base pt-4">
        <div className="flex items-center gap-2">
          <Switch checked={!!p.archived} onCheckedChange={(on) => onChange({ archived: on || undefined })} />
          <Label size="xsmall">Archived (can't be received; existing products keep their prices)</Label>
        </div>
        {!isSaved && (
          <Button variant="transparent" size="small" onClick={onRemove}>Remove</Button>
        )}
      </div>
    </div>
  )
}

const SizesEditor = ({ sizes, onChange }: { sizes: Size[]; onChange: (s: Size[]) => void }) => {
  const set = (i: number, patch: Partial<Size>) => onChange(sizes.map((s, x) => (x === i ? { ...s, ...patch } : s)))
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_1.5fr_0.8fr_0.8fr_0.8fr_0.8fr_auto] gap-2">
        {["Key", "Label", "Stock used", "Grams", "Unit", "Units each", ""].map((h) => (
          <Text key={h} size="xsmall" className="text-ui-fg-subtle">{h}</Text>
        ))}
        {sizes.map((s, i) => (
          <SizeRow key={i} size={s} onChange={(patch) => set(i, patch)} onRemove={() => onChange(sizes.filter((_, x) => x !== i))} />
        ))}
      </div>
      <Text size="xsmall" className="text-ui-fg-subtle">
        Key: letters and digits only (no hyphens), e.g. qp, 30pk. Grams, or Unit + Units each, drive per-unit prices on the storefront.
      </Text>
      <div>
        <Button variant="secondary" size="small" onClick={() => onChange([...sizes, { sizeKey: "", label: "", multiplier: 1 }])}>Add size</Button>
      </div>
    </div>
  )
}

const SizeRow = ({ size: s, onChange, onRemove }: { size: Size; onChange: (p: Partial<Size>) => void; onRemove: () => void }) => (
  <>
    <Input size="small" value={s.sizeKey} onChange={(e) => onChange({ sizeKey: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") })} />
    <Input size="small" value={s.label} onChange={(e) => onChange({ label: e.target.value })} />
    <Input size="small" type="number" min="0" step="any" value={s.multiplier} onChange={(e) => onChange({ multiplier: e.target.value })} />
    <Input size="small" type="number" min="0" step="any" value={s.grams ?? ""} onChange={(e) => onChange({ grams: e.target.value || undefined })} />
    <Input size="small" value={s.unitLabel ?? ""} placeholder="pc" onChange={(e) => onChange({ unitLabel: e.target.value || undefined })} />
    <Input size="small" type="number" min="0" step="any" value={s.unitsPerVariant ?? ""} onChange={(e) => onChange({ unitsPerVariant: e.target.value || undefined })} />
    <Button variant="transparent" size="small" onClick={onRemove}>✕</Button>
  </>
)

const Pair = ({ value, onChange }: { value: Unit; onChange: (u: Unit) => void }) => (
  <div className="flex gap-2">
    <Input size="small" value={value?.singular ?? ""} onChange={(e) => onChange({ ...value, singular: e.target.value })} />
    <Input size="small" value={value?.plural ?? ""} onChange={(e) => onChange({ ...value, plural: e.target.value })} />
  </div>
)

const Section = ({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-2">
    <Text size="small" weight="plus">{title}</Text>
    {hint && <Text size="xsmall" className="text-ui-fg-subtle">{hint}</Text>}
    {children}
  </div>
)

const Grid = ({ children }: { children: ReactNode }) => (
  <div className="grid grid-cols-2 gap-3">{children}</div>
)

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1">
    <Label size="xsmall" weight="plus">{label}</Label>
    {children}
    {hint && <Text size="xsmall" className="text-ui-fg-subtle">{hint}</Text>}
  </div>
)

import { Button, Input, Label, Switch, Text, Textarea, toast } from "@medusajs/ui"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { CANNABINOIDS, cannabinoidField } from "../lib/cannabinoids"

/**
 * MBS Settings → Categories. The one place a category is set up: it
 * creates and renames the Medusa categories (through
 * /admin/mbs/category-profiles/categories) and edits the
 * `category_profiles` setting (/admin/mbs/category-profiles, which
 * validates the whole list before writing, lib/profile-store.ts).
 *
 * Profiles link to their Medusa categories by id, so a rename (here or
 * in Medusa) changes nothing else. Top-level Medusa categories nothing
 * receives into show as "Not set up".
 */

type Size = {
  sizeKey: string
  label: string
  multiplier: number | string
  grams?: number | string
  unitLabel?: string
  unitsPerVariant?: number | string
}
type Sub = { key: string; categoryId?: string; medusaName: string; label: string; variants?: Size[] }
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
  categoryId?: string
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
  priceTables?: Record<string, string>
  shippingRatesKey?: string
  primaryCannabinoid?: string
  invoiceUpload?: boolean
}
type Category = { id: string; name: string; handle: string; parent_category_id: string | null; is_active?: boolean }

const FIELD_LABELS: Array<[keyof Fields, string]> = [
  ["strainType", "Strain type (Indica / Sativa / Hybrid)"],
  ["bestFor", "Best for (day / evening / night)"],
  ["effects", "Effects"],
  ["cannabinoids", "Cannabinoid %"],
  ["coaRequired", "COA required"],
  ["upc", "UPC barcode"],
]

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
const tableSlug = (s: string) => slug(s).replace(/-/g, "_")

/* A new category starts with one size, its own blank price tables and
 * shipping bucket, so its sections appear in the price and shipping
 * tabs straight away. */
const newProfile = (cat: Category, subs: Category[], taken: Set<string>): Profile => {
  let key = slug(cat.name) || "category"
  for (let i = 2; taken.has(key); i++) key = `${slug(cat.name)}-${i}`
  const t = tableSlug(key)
  return {
    key,
    displayName: cat.name,
    categoryId: cat.id,
    parentCategoryName: cat.name,
    subcategories: subs.map((c) => ({ key: slug(c.name), categoryId: c.id, medusaName: c.name, label: c.name })),
    variants: [{ sizeKey: "unit", label: "Unit", multiplier: 1 }],
    fields: { strainType: false, bestFor: false, effects: false, cannabinoids: false, coaRequired: true, upc: true },
    invoiceUpload: false,
    pricingModel: "tier",
    tierPricesSettingKey: `${t}_prices`,
    unitLabel: { singular: "Unit", plural: "Units" },
    inputUnitLabel: { singular: "unit", plural: "units" },
    inputToPoolMultiplier: 1,
    priceTables: {
      tier_2: `${t}_tier_2_prices`,
      tier_3: `${t}_tier_3_prices`,
      distro: `${t}_distro_prices`,
      owner: `${t}_owner_markup_per_unit`,
    },
    shippingRatesKey: t,
  }
}

const selectCls = "h-8 w-full border border-ui-border-base bg-ui-bg-field px-2 text-sm rounded-md"

async function categoryAction(body: Record<string, unknown>) {
  const res = await fetch("/admin/mbs/category-profiles/categories", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.message ?? `Request failed (${res.status})`)
  return json
}

/* "Flower › CBD" for a category id. */
function pathOf(categories: Category[], id?: string): string {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const names: string[] = []
  for (let c = id ? byId.get(id) : undefined, hops = 0; c && hops < 20; hops++) {
    names.unshift(c.name)
    c = c.parent_category_id ? byId.get(c.parent_category_id) : undefined
  }
  return names.join(" › ")
}

export const CategoryProfilesForm = () => {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())
  const [categories, setCategories] = useState<Category[]>([])
  const [unlinked, setUnlinked] = useState<Category[]>([])
  const [source, setSource] = useState<string>("")
  const [open, setOpen] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
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
      setUnlinked(json.unlinked ?? [])
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

  /* Medusa changed under us (create / add / rename): refresh the tree
   * without touching unsaved profile edits. */
  const refreshCategories = async () => {
    const res = await fetch("/admin/mbs/category-profiles", { credentials: "include" })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      setCategories(json.categories ?? [])
      setUnlinked(json.unlinked ?? [])
    }
  }

  const addLinked = (cat: Category, subs: Category[]) => {
    const p = newProfile(cat, subs, new Set(profiles.map((x) => x.key)))
    setProfiles((list) => [...list, p])
    setOpen(profiles.length)
    setUnlinked((list) => list.filter((c) => c.id !== cat.id))
  }

  const setUp = (cat: Category) =>
    addLinked(cat, categories.filter((c) => c.parent_category_id === cat.id && c.is_active !== false))

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
      toast.success("Categories saved")
      for (const w of json.warnings ?? []) toast.warning(w)
      await load()
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
        Every category is set up here: its Medusa categories, how it's received (units, sizes, the
        fields the receiving form asks for) and its price tables. Adding or renaming a category or
        sub-category here does it in Medusa too. Sub-categories added straight in Medusa still show up.
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
              <Text size="xsmall" as="span" className="text-ui-fg-subtle ml-2">
                {p.categoryId ? pathOf(categories, p.categoryId) || "Medusa category missing" : p.parentCategoryName}
              </Text>
              {p.archived && <Text size="xsmall" as="span" className="text-ui-fg-muted ml-2">· archived</Text>}
              {!savedKeys.has(p.key) && <Text size="xsmall" as="span" className="text-ui-fg-interactive ml-2">· not saved yet</Text>}
            </span>
            <Text size="xsmall" className="text-ui-fg-subtle">{open === i ? "Close" : "Edit"}</Text>
          </button>
          {open === i && (
            <ProfileEditor
              profile={p}
              isSaved={savedKeys.has(p.key)}
              categories={categories}
              onCategoriesChanged={refreshCategories}
              onChange={(patch) => update(i, patch)}
              onRemove={() => {
                setProfiles((list) => list.filter((_, idx) => idx !== i))
                setOpen(null)
                refreshCategories()
              }}
            />
          )}
        </div>
      ))}

      {unlinked.map((c) => (
        <div key={c.id} className="border border-dashed border-ui-border-strong rounded-md px-4 py-3 flex items-center justify-between">
          <span>
            <Text size="small" weight="plus" as="span">{c.name}</Text>
            <Text size="xsmall" as="span" className="text-ui-fg-subtle ml-2">In Medusa · not set up</Text>
          </span>
          <Button variant="secondary" size="small" onClick={() => setUp(c)}>Set up receiving</Button>
        </div>
      ))}

      {adding && (
        <AddCategory
          categories={categories}
          onCancel={() => setAdding(false)}
          onCreated={async (cat, subs) => {
            setAdding(false)
            await refreshCategories()
            addLinked(cat, subs)
            toast.success(`${cat.name} created in Medusa`, {
              description: "Fill in its sizes and units below, then press Save categories.",
            })
          }}
        />
      )}

      <div className="flex gap-2">
        {!adding && <Button variant="secondary" size="small" onClick={() => setAdding(true)}>Add category</Button>}
        <Button size="small" onClick={save} isLoading={saving}>Save categories</Button>
      </div>
    </div>
  )
}

const AddCategory = ({
  categories,
  onCancel,
  onCreated,
}: {
  categories: Category[]
  onCancel: () => void
  onCreated: (cat: Category, subs: Category[]) => void
}) => {
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState("")
  const [subs, setSubs] = useState("")
  const [busy, setBusy] = useState(false)
  const subNames = subs.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

  const create = async () => {
    if (!name.trim()) { toast.error("Give the category a name."); return }
    setBusy(true)
    try {
      const j = await categoryAction({ action: "create", name, parentId: parentId || undefined, subcategories: subNames })
      onCreated(j.category, j.subcategories ?? [])
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't create the category")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-ui-border-base rounded-md px-4 py-4 flex flex-col gap-3">
      <Text size="small" weight="plus">New category</Text>
      <Grid>
        <Field label="Name">
          <Input size="small" value={name} placeholder="Edibles" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Put it under" hint="Top level for a new kind of product. Under Flower for a new Flower branch next to CBD and CBG.">
          <select className={selectCls} value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top level</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{pathOf(categories, c.id)}</option>)}
          </select>
        </Field>
      </Grid>
      <Field label="Sub-categories" hint="One per line or comma-separated, e.g. Gummies, Chocolates. Each receiving row picks one. You can add more later.">
        <Textarea value={subs} rows={3} onChange={(e) => setSubs(e.target.value)} />
      </Field>
      <Text size="xsmall" className="text-ui-fg-subtle">
        Creates {name.trim() || "the category"}{subNames.length > 0 ? ` and ${subNames.length} sub-categor${subNames.length === 1 ? "y" : "ies"}` : ""} in Medusa now. The receiving setup is stored when you press Save categories.
      </Text>
      <div className="flex gap-2">
        <Button size="small" onClick={create} isLoading={busy}>Create</Button>
        <Button variant="transparent" size="small" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

/* A Medusa category name with an inline Rename. */
const RenameableName = ({
  category,
  onRenamed,
}: {
  category: Category | undefined
  onRenamed: (name: string) => void
}) => {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(category?.name ?? "")
  const [busy, setBusy] = useState(false)
  if (!category) return <Text size="small" className="text-ui-fg-error">Missing in Medusa</Text>

  const submit = async () => {
    const next = text.trim()
    if (!next || next === category.name) { setEditing(false); return }
    setBusy(true)
    try {
      await categoryAction({ action: "rename", id: category.id, name: next })
      onRenamed(next)
      setEditing(false)
      toast.success(`Renamed to ${next}`)
    } catch (e: any) {
      toast.error(e?.message ?? "Rename failed")
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <Text size="small">{category.name}</Text>
        {category.is_active === false && <Text size="xsmall" className="text-ui-fg-muted">inactive</Text>}
        <Button variant="transparent" size="small" onClick={() => { setText(category.name); setEditing(true) }}>Rename</Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Input size="small" value={text} autoFocus onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setEditing(false) }} />
      <Button size="small" onClick={submit} isLoading={busy}>Rename</Button>
      <Button variant="transparent" size="small" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
    </div>
  )
}

const ProfileEditor = ({
  profile: p,
  isSaved,
  categories,
  onCategoriesChanged,
  onChange,
  onRemove,
}: {
  profile: Profile
  isSaved: boolean
  categories: Category[]
  onCategoriesChanged: () => Promise<void> | void
  onChange: (patch: Partial<Profile>) => void
  onRemove: () => void
}) => {
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const root = p.categoryId ? byId.get(p.categoryId) : undefined
  const [newSub, setNewSub] = useState("")
  const [addingSub, setAddingSub] = useState(false)

  const setSub = (si: number, patch: Partial<Sub>) => {
    const subs = [...p.subcategories]
    subs[si] = { ...subs[si], ...patch }
    onChange({ subcategories: subs })
  }

  const addSub = async () => {
    const name = newSub.trim()
    if (!name || !root) return
    setAddingSub(true)
    try {
      const j = await categoryAction({ action: "add-sub", parentId: root.id, name })
      const taken = new Set(p.subcategories.map((s) => s.key))
      let key = slug(name) || "sub"
      for (let i = 2; taken.has(key); i++) key = `${slug(name)}-${i}`
      onChange({ subcategories: [...p.subcategories, { key, categoryId: j.category.id, medusaName: name, label: name }] })
      setNewSub("")
      await onCategoriesChanged()
      toast.success(`${name} added under ${root.name}`, { description: "Press Save categories to store its setup." })
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't add the sub-category")
    } finally {
      setAddingSub(false)
    }
  }

  return (
    <div className="border-t border-ui-border-base px-4 py-4 flex flex-col gap-5">
      <Section title="Category">
        <Grid>
          <Field label="Display name" hint="What receiving and the price tabs call it.">
            <Input
              size="small"
              value={p.displayName}
              onChange={(e) => onChange({ displayName: e.target.value })}
            />
          </Field>
          <Field label="Key" hint={isSaved ? "Fixed once saved: drafts and products refer to it." : "Lowercase words joined by hyphens."}>
            <Input size="small" value={p.key} disabled={isSaved} onChange={(e) => onChange({ key: slug(e.target.value) })} />
          </Field>
          <Field label="Medusa category" hint={root ? pathOf(categories, root.id) : undefined}>
            <RenameableName
              key={root?.id}
              category={root}
              onRenamed={() => onCategoriesChanged()}
            />
          </Field>
          <Field label="Receives into" hint="Only change this to point the setup at a different Medusa category.">
            <select
              className={selectCls}
              value={p.categoryId ?? ""}
              onChange={(e) => {
                const cat = byId.get(e.target.value)
                if (!cat) return
                onChange({
                  categoryId: cat.id,
                  subcategories: categories
                    .filter((c) => c.parent_category_id === cat.id && c.is_active !== false)
                    .map((c) => ({ key: slug(c.name), categoryId: c.id, medusaName: c.name, label: c.name })),
                })
              }}
            >
              {!p.categoryId && <option value="">Choose…</option>}
              {categories.map((c) => <option key={c.id} value={c.id}>{pathOf(categories, c.id)}</option>)}
            </select>
          </Field>
        </Grid>
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

      <Section title="Sub-categories" hint="Each receiving row picks one. Renames and new sub-categories happen in Medusa right away.">
        {p.subcategories.map((s, si) => {
          const cat = s.categoryId ? byId.get(s.categoryId) : categories.find((c) => c.parent_category_id === root?.id && c.name === s.medusaName)
          return (
            <div key={s.categoryId ?? si} className="border border-ui-border-base rounded-md p-3 flex flex-col gap-3">
              <Grid>
                <Field label="Medusa category">
                  <RenameableName
                    key={cat?.id}
                    category={cat}
                    onRenamed={(name) => {
                      setSub(si, { medusaName: name, ...(s.label === s.medusaName ? { label: name } : {}) })
                      onCategoriesChanged()
                    }}
                  />
                </Field>
                <Field label="Key" hint={isSaved && s.categoryId ? "Used in SKUs and price tables; fixed." : "Used in SKUs and price tables."}>
                  <Input size="small" value={s.key} disabled={isSaved && !!s.categoryId && !!s.key}
                    onChange={(e) => setSub(si, { key: slug(e.target.value) })} />
                </Field>
                <Field label="Label" hint="Shown in receiving and the price tabs.">
                  <Input size="small" value={s.label} onChange={(e) => setSub(si, { label: e.target.value })} />
                </Field>
              </Grid>
              <div className="flex items-center gap-2">
                <Switch
                  checked={!!s.variants?.length}
                  onCheckedChange={(on) => setSub(si, { variants: on ? [{ sizeKey: "", label: "", multiplier: 1 }] : undefined })}
                />
                <Label size="xsmall">Own sizes (e.g. Hashholes sell 15 ct boxes while the rest sell 30 ct)</Label>
              </div>
              {!!s.variants?.length && (
                <SizesEditor sizes={s.variants} onChange={(variants) => setSub(si, { variants })} />
              )}
            </div>
          )
        })}
        {root ? (
          <div className="flex items-center gap-2">
            <Input size="small" value={newSub} placeholder={`New sub-category under ${root.name}`}
              onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addSub() }} />
            <Button variant="secondary" size="small" onClick={addSub} isLoading={addingSub} disabled={!newSub.trim()}>
              Add sub-category
            </Button>
          </div>
        ) : (
          <Text size="xsmall" className="text-ui-fg-subtle">Pick its Medusa category above to add sub-categories.</Text>
        )}
      </Section>

      <Section title="Receiving form asks for">
        <div className="grid grid-cols-2 gap-2">
          {FIELD_LABELS.map(([k, label]) => (
            <div key={k} className="flex items-center gap-2">
              <Switch
                checked={!!p.fields[k]}
                onCheckedChange={(on) => onChange({
                  fields: { ...p.fields, [k]: on },
                  /* Turning cannabinoids on needs a main one; CBD is what MBS sells. */
                  ...(k === "cannabinoids" && on && !p.primaryCannabinoid ? { primaryCannabinoid: "CBD" } : {}),
                })}
              />
              <Label size="xsmall">{label}</Label>
            </div>
          ))}
        </div>
        {p.fields.cannabinoids && (
          <Grid>
            <Field label="Main cannabinoid"
              hint={`The % column is "${cannabinoidField(p.primaryCannabinoid).label}", and the COA reader looks for ${p.primaryCannabinoid ?? "THC-A"}.`}>
              <select className={selectCls} value={p.primaryCannabinoid ?? "THC-A"}
                onChange={(e) => onChange({ primaryCannabinoid: e.target.value })}>
                {CANNABINOIDS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </Grid>
        )}
        <div className="flex items-center gap-2">
          <Switch checked={!!p.invoiceUpload} onCheckedChange={(on) => onChange({ invoiceUpload: on })} />
          <Label size="xsmall">
            Receive by invoice upload: offered on the main Receiving page, which reads the supplier's invoice
            in {p.inputUnitLabel.plural || "its receiving unit"}
          </Label>
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
          <Button variant="transparent" size="small" onClick={onRemove}>Remove setup</Button>
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

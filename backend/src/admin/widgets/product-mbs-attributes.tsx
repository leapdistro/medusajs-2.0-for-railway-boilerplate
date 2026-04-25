import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
  toast,
} from "@medusajs/ui"
import { useEffect, useMemo, useState } from "react"

/* Tier dropdown was removed on 2026-04-25 — tier now derives from the
 * product's sub-category assignment. Operators set tier by picking the
 * Classic / Exotic / Super / Rapper / Snowcaps sub-cat in the Organize
 * section of the product create flow. No separate tier dropdown here. */

const STRAIN_OPTS = [
  { value: "Indica",  label: "Indica" },
  { value: "Sativa",  label: "Sativa" },
  { value: "Hybrid",  label: "Hybrid" },
]

const BEST_FOR_OPTS = [
  { value: "day",     label: "Day" },
  { value: "evening", label: "Evening" },
  { value: "night",   label: "Night" },
]

const POTENCY_OPTS = [
  { value: "1", label: "Low ●○○" },
  { value: "2", label: "Med ●●○" },
  { value: "3", label: "High ●●●" },
]

const ALL_EFFECTS = [
  "Chill", "Energy", "Relief", "Sleep", "Focus",
  "Grounded", "Creative", "Social", "Calm",
] as const

type Form = {
  strain_type: string
  best_for: string
  potency: string
  thca_percent: string
  total_cannabinoids_percent: string
  effects: string[]
  coa_url: string
}

const EMPTY_FORM: Form = {
  strain_type: "",
  best_for: "",
  potency: "",
  thca_percent: "",
  total_cannabinoids_percent: "",
  effects: [],
  coa_url: "",
}

const ProductMbsAttributesWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const productId = data.id
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/admin/products/${productId}/mbs-attributes`, { credentials: "include" })
      .then((r) => r.json())
      .then(({ attributes }) => {
        if (cancelled || !attributes) return
        setForm({
          strain_type: attributes.strain_type ?? "",
          best_for: attributes.best_for ?? "",
          potency: attributes.potency != null ? String(attributes.potency) : "",
          thca_percent: attributes.thca_percent != null ? String(attributes.thca_percent) : "",
          total_cannabinoids_percent:
            attributes.total_cannabinoids_percent != null
              ? String(attributes.total_cannabinoids_percent)
              : "",
          effects: Array.isArray(attributes.effects) ? attributes.effects : [],
          coa_url: attributes.coa_url ?? "",
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [productId])

  const toggleEffect = (effect: string) => {
    setForm((f) => {
      if (f.effects.includes(effect)) {
        return { ...f, effects: f.effects.filter((e) => e !== effect) }
      }
      if (f.effects.length >= 2) {
        toast.warning("Maximum 2 effects per product")
        return f
      }
      return { ...f, effects: [...f.effects, effect] }
    })
  }

  const onSave = async () => {
    setSaving(true)
    try {
      const payload = {
        strain_type: form.strain_type || null,
        best_for: form.best_for || null,
        potency: form.potency ? Number(form.potency) : null,
        thca_percent: form.thca_percent || null,
        total_cannabinoids_percent: form.total_cannabinoids_percent || null,
        effects: form.effects.length ? form.effects : null,
        coa_url: form.coa_url || null,
      }
      const res = await fetch(`/admin/products/${productId}/mbs-attributes`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      toast.success("MBS attributes saved")
    } catch (e: any) {
      toast.error(e?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const effectsCount = form.effects.length

  const SelectField = ({
    label,
    value,
    onChange,
    options,
    placeholder,
  }: {
    label: string
    value: string
    onChange: (v: string) => void
    options: { value: string; label: string }[]
    placeholder: string
  }) => (
    <div className="flex flex-col gap-y-2">
      <Label size="small" weight="plus">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <Select.Trigger><Select.Value placeholder={placeholder} /></Select.Trigger>
        <Select.Content>
          {options.map((o) => (
            <Select.Item key={o.value} value={o.value}>{o.label}</Select.Item>
          ))}
        </Select.Content>
      </Select>
    </div>
  )

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">MBS Attributes</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Cannabis-specific fields used by the storefront (strain, potency, COA, effects). Tier comes from the sub-category in Organize.
          </Text>
        </div>
        <Button variant="primary" onClick={onSave} isLoading={saving} disabled={loading}>
          Save attributes
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 px-6 py-6 md:grid-cols-2">
        <SelectField
          label="Strain Type"
          value={form.strain_type}
          onChange={(v) => setForm({ ...form, strain_type: v })}
          options={STRAIN_OPTS}
          placeholder="Indica / Sativa / Hybrid"
        />
        <SelectField
          label="Best For"
          value={form.best_for}
          onChange={(v) => setForm({ ...form, best_for: v })}
          options={BEST_FOR_OPTS}
          placeholder="Day / Evening / Night"
        />
        <SelectField
          label="Potency"
          value={form.potency}
          onChange={(v) => setForm({ ...form, potency: v })}
          options={POTENCY_OPTS}
          placeholder="1 / 2 / 3"
        />
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">COA URL</Label>
          <Input
            value={form.coa_url}
            onChange={(e) => setForm({ ...form, coa_url: e.target.value })}
            placeholder="/coas/northern-lights.pdf"
          />
        </div>
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">THCa %</Label>
          <Input
            type="number"
            step="0.1"
            value={form.thca_percent}
            onChange={(e) => setForm({ ...form, thca_percent: e.target.value })}
            placeholder="26.4"
          />
        </div>
        <div className="flex flex-col gap-y-2">
          <Label size="small" weight="plus">Total Cannabinoids %</Label>
          <Input
            type="number"
            step="0.1"
            value={form.total_cannabinoids_percent}
            onChange={(e) => setForm({ ...form, total_cannabinoids_percent: e.target.value })}
            placeholder="24.3"
          />
        </div>
      </div>

      <div className="flex flex-col gap-y-3 px-6 py-6">
        <div className="flex items-center justify-between">
          <Label size="small" weight="plus">Effects (pick up to 2)</Label>
          <Text size="small" className="text-ui-fg-subtle">{effectsCount}/2 selected</Text>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_EFFECTS.map((eff) => {
            const selected = form.effects.includes(eff)
            return (
              <button
                key={eff}
                type="button"
                onClick={() => toggleEffect(eff)}
                className="focus:outline-none"
              >
                <Badge
                  size="small"
                  color={selected ? "green" : "grey"}
                  className="cursor-pointer"
                >
                  {eff}
                </Badge>
              </button>
            )
          })}
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.after",
})

export default ProductMbsAttributesWidget

/* A category's cannabinoids (MBS Settings → Categories) → the receiving
 * column label and the SaveRow field each % is sent in. The save route
 * writes each field to its own product attribute (cbdPercent →
 * cbd_percent). Values match PRIMARY_CANNABINOIDS in
 * lib/receiving-profiles.ts. */

export const CANNABINOIDS = ["CBD", "CBG", "THC-A", "THC-P", "D9"] as const
export type Cannabinoid = (typeof CANNABINOIDS)[number]

type RowField = "cbdPercent" | "cbgPercent" | "thcaPercent" | "thcpPercent" | "d9Percent"
type CannabinoidField = {
  label: string
  rowField: RowField
  /* Labs print "ND" (none detected) for D9, so its box takes text. */
  allowsNd: boolean
}

const FIELDS: Record<Cannabinoid, CannabinoidField> = {
  CBD: { label: "CBD %", rowField: "cbdPercent", allowsNd: false },
  CBG: { label: "CBG %", rowField: "cbgPercent", allowsNd: false },
  "THC-A": { label: "THCa %", rowField: "thcaPercent", allowsNd: false },
  "THC-P": { label: "THCp %", rowField: "thcpPercent", allowsNd: false },
  D9: { label: "D9 %", rowField: "d9Percent", allowsNd: true },
}

/** Column label and SaveRow field for a category's main cannabinoid.
 *  A category without one records THCa, as receiving always did. */
export function cannabinoidField(primary: string | null | undefined): CannabinoidField {
  return FIELDS[(primary ?? "") as Cannabinoid] ?? FIELDS["THC-A"]
}

export type OtherCannabinoid = { cannabinoid: string; required: boolean }
export type OtherCannabinoidColumn = CannabinoidField & { cannabinoid: Cannabinoid; required: boolean }

/** The columns recorded next to the main cannabinoid, in settings order.
 *  Unknown names and the main one are dropped, so a stale list can't
 *  send the main % twice. */
export function otherCannabinoidColumns(
  primary: string | null | undefined,
  others: OtherCannabinoid[] | null | undefined,
): OtherCannabinoidColumn[] {
  const main = cannabinoidField(primary).rowField
  return (others ?? []).flatMap((o) => {
    const f = FIELDS[o.cannabinoid as Cannabinoid]
    return f && f.rowField !== main ? [{ ...f, cannabinoid: o.cannabinoid as Cannabinoid, required: !!o.required }] : []
  })
}

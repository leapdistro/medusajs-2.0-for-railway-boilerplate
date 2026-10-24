/* A category's main cannabinoid (MBS Settings → Categories) → the
 * receiving column label and the SaveRow field its % is sent in. The
 * save route writes each field to its own product attribute
 * (cbdPercent → cbd_percent). Values match PRIMARY_CANNABINOIDS in
 * lib/receiving-profiles.ts. */

export const CANNABINOIDS = ["CBD", "CBG", "THC-A", "THC-P"] as const
export type Cannabinoid = (typeof CANNABINOIDS)[number]

const FIELDS: Record<Cannabinoid, { label: string; rowField: "cbdPercent" | "cbgPercent" | "thcaPercent" | "thcpPercent" }> = {
  CBD: { label: "CBD %", rowField: "cbdPercent" },
  CBG: { label: "CBG %", rowField: "cbgPercent" },
  "THC-A": { label: "THCa %", rowField: "thcaPercent" },
  "THC-P": { label: "THCp %", rowField: "thcpPercent" },
}

/** Column label and SaveRow field for a category's main cannabinoid.
 *  A category without one records THCa, as receiving always did. */
export function cannabinoidField(primary: string | null | undefined) {
  return FIELDS[(primary ?? "") as Cannabinoid] ?? FIELDS["THC-A"]
}

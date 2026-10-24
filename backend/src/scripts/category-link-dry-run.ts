import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { loadProfiles, normalizeProfileList, resolveProfileCategories } from "../lib/profile-store"

/**
 * Read-only. Links every current category profile to its Medusa
 * categories by id (what the Categories tab will store on its next
 * save), then checks the linked list resolves exactly like today's:
 * same root, same sub-categories with the same keys, labels, ids and
 * sizes, same price tables and shipping bucket. Nothing is written.
 *
 *   npx medusa exec ./src/scripts/category-link-dry-run.ts
 */
export default async function categoryLinkDryRun({ container }: { container: any }) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { profiles, source } = await loadProfiles(container)
  console.log(`profiles: ${profiles.length} (source: ${source})\n`)

  const before = await Promise.all(profiles.map((p) => resolveProfileCategories(query, p)))
  const { profiles: linked, errors } = normalizeProfileList(before.map((r) => r.linked))
  if (errors.length > 0) {
    console.log("LINKED LIST FAILS VALIDATION:\n  " + errors.join("\n  "))
    return
  }
  const after = await Promise.all(linked.map((p) => resolveProfileCategories(query, p)))

  /* Everything a consumer reads from a resolved profile, keys sorted so
   * field order doesn't count as a difference. */
  const stable = (v: any): any =>
    Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
    : v
  const shape = (r: Awaited<ReturnType<typeof resolveProfileCategories>>) => {
    const { subcategories, ...rest } = r.profile
    return JSON.stringify(stable({
      ...rest,
      parent: r.parent?.id ?? null,
      root: r.enumRoot?.id ?? null,
      subcategories: subcategories.map((s) => ({
        key: s.key, label: s.label, id: s.id, handle: s.handle, name: s.medusaName, variants: s.variants,
      })),
    }))
  }

  let diffs = 0
  for (const [i, b] of before.entries()) {
    const a = after[i]
    const p = b.linked
    console.log(`${p.displayName} [${p.key}]${p.archived ? " (archived)" : ""}`)
    console.log(`  receives into: ${b.enumRoot ? `${b.parent?.name ?? "?"}${b.parent?.id !== b.enumRoot.id ? ` › ${b.enumRoot.name}` : ""}  ${b.enumRoot.id}` : "NOT FOUND IN MEDUSA"}`)
    for (const s of b.profile.subcategories) {
      console.log(`    ${s.key.padEnd(10)} → ${s.medusaName} ${s.id}  sizes: ${s.variants.map((v) => v.sizeKey).join("/")}`)
    }
    if (shape(b) === shape(a)) {
      console.log("  ✓ identical after linking by id\n")
    } else {
      diffs++
      console.log("  ✗ DIFFERS after linking")
      console.log("    before: " + shape(b))
      console.log("    after:  " + shape(a) + "\n")
    }
  }
  console.log(diffs === 0 ? "RESULT: all profiles identical. Safe to store ids." : `RESULT: ${diffs} profile(s) differ. Do not save.`)

  /* Rename simulation, in memory only: every category gets " (renamed)"
   * appended. Linked profiles must keep the same root, sub-category keys
   * and ids; the name-matched ones show what breaks today. */
  const { data: real } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle", "parent_category_id", "is_active", "metadata"],
  })
  const renamed = (real as any[]).map((c) => ({ ...c, name: `${c.name} (renamed)` }))
  const fakeQuery = { graph: async () => ({ data: renamed }) }
  const keysOf = (r: Awaited<ReturnType<typeof resolveProfileCategories>>) =>
    `${r.enumRoot?.id ?? "none"} | ` + r.profile.subcategories.map((s) => `${s.key}=${s.id}`).join(",")
  console.log("\nRename simulation (every category renamed, in memory):")
  for (const [i, b] of before.entries()) {
    const today = await resolveProfileCategories(fakeQuery, profiles[i])
    const withIds = await resolveProfileCategories(fakeQuery, linked[i])
    const ok = keysOf(withIds) === keysOf(b)
    const todayOk = keysOf(today) === keysOf(b)
    console.log(`  ${b.linked.displayName}: linked by id ${ok ? "keeps working" : "BREAKS"} · by name today ${todayOk ? "keeps working" : "breaks"}`)
  }
}

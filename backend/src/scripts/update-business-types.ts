import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MBS_SETTINGS_MODULE } from "../modules/mbs-settings"

/**
 * One-shot: update the live `business_types` setting to:
 *   - relabel `smoke_shop` to "Smoke/Vape Shop"
 *   - add `c_store` ("C-Store")
 *   - archive `vape_shop` (preserve id for historical applications)
 *
 * seed-settings.ts only writes a key if it's UNSET — re-running it
 * here would no-op against an existing setting. This script does a
 * read-modify-write of the live row instead.
 *
 * Idempotent — safe to re-run; each operation checks current state
 * and patches only when needed.
 *
 * Run on Railway:
 *   pnpm exec medusa exec ./src/scripts/update-business-types.ts
 */

type Row = { id: string; label: string; archived?: boolean }

export default async function updateBusinessTypes({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const settings: any = container.resolve(MBS_SETTINGS_MODULE)

  const current = ((await settings.getSetting("business_types")) ?? []) as Row[]
  const byId: Record<string, Row> = {}
  for (const r of current) byId[r.id] = { ...r }

  let changes = 0

  /* 1. smoke_shop → "Smoke/Vape Shop" */
  if (byId.smoke_shop) {
    if (byId.smoke_shop.label !== "Smoke/Vape Shop" || byId.smoke_shop.archived) {
      byId.smoke_shop.label = "Smoke/Vape Shop"
      byId.smoke_shop.archived = false
      logger.info(`  · relabeled smoke_shop → "Smoke/Vape Shop"`)
      changes += 1
    }
  } else {
    byId.smoke_shop = { id: "smoke_shop", label: "Smoke/Vape Shop", archived: false }
    logger.info(`  + added smoke_shop ("Smoke/Vape Shop")`)
    changes += 1
  }

  /* 2. c_store ("C-Store") — new */
  if (!byId.c_store) {
    byId.c_store = { id: "c_store", label: "C-Store", archived: false }
    logger.info(`  + added c_store ("C-Store")`)
    changes += 1
  } else if (byId.c_store.archived) {
    byId.c_store.archived = false
    logger.info(`  · unarchived c_store`)
    changes += 1
  }

  /* 3. vape_shop → archived (preserve id for past applications). */
  if (byId.vape_shop && !byId.vape_shop.archived) {
    byId.vape_shop.archived = true
    logger.info(`  · archived vape_shop (id retained for old applications)`)
    changes += 1
  }

  if (changes === 0) {
    logger.info("✓ business_types already up to date — no changes")
    return
  }

  /* Preserve original ordering for unchanged ids; new entries (c_store)
   * land at end of the displayed list. Operators can reorder later via
   * a future admin tab if it ships. */
  const orderedIds: string[] = current.map((r) => r.id)
  for (const id of Object.keys(byId)) {
    if (!orderedIds.includes(id)) orderedIds.push(id)
  }
  const next: Row[] = orderedIds.map((id) => byId[id]).filter(Boolean)

  await settings.setSetting("business_types", next)
  logger.info(`✓ business_types updated — ${changes} change(s) applied`)
}

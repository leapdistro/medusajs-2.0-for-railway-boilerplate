import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { ExecArgs } from "@medusajs/framework/types"

/**
 * One-off — adds the `batch_id` column to product_attributes.
 *
 * Reason this exists: the migration in
 * `backend/src/modules/mbs-attributes/migrations/Migration20260610000001.ts`
 * didn't run on the Railway deploy that introduced it (cause unclear —
 * `init-backend` is supposed to invoke `npx medusa db:migrate` on boot
 * but the column was still missing). This script bypasses the migration
 * runner entirely and issues the DDL directly via the manager's
 * connection.
 *
 * Idempotent — uses `if not exists`, so re-running is a no-op.
 *
 * Run with: `pnpm medusa exec ./src/scripts/add-batch-id-column.ts`
 *
 * After this succeeds, the migration entry can stay as-is — when
 * MikroORM scans on the next boot it'll see the column already exists
 * and `add column if not exists` makes the migration a no-op.
 */
export default async function addBatchIdColumn({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const manager: any = container.resolve("manager")

  logger.info("▶ Adding batch_id column to product_attributes…")

  try {
    await manager.execute(
      `alter table "product_attributes" add column if not exists "batch_id" text null;`,
    )
    logger.info("✓ batch_id column added (or already existed).")

    /* Sanity-check: read the column from information_schema so the
     * operator gets confirmation the change is in place. */
    const rows = await manager.execute(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_name = 'product_attributes' and column_name = 'batch_id';
    `)
    logger.info(`Column inspect: ${JSON.stringify(rows)}`)
  } catch (e: any) {
    logger.error(`✗ Failed: ${e?.message ?? e}`)
    throw e
  }
}

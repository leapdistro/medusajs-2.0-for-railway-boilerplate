import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Drop `tier` column from product_attributes. Tier is now derived from the
 * product's sub-category assignment (Classic / Exotic / Super / Rapper /
 * Snowcaps), with the storefront reading either `category.metadata.tier_key`
 * (preferred, admin-editable) or the category handle (fallback).
 *
 * Safe to apply because:
 *  - Catalog was wiped via `pnpm wipe:catalog` before this migration
 *  - Even on a populated DB, dropping the column is non-destructive to
 *    other fields and the down() restores the enum constraint
 */
export class Migration20260425000001 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "product_attributes" drop column if exists "tier";`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "product_attributes" add column if not exists "tier" text check ("tier" in ('classic', 'exotic', 'super', 'rapper', 'snow')) null;`);
  }

}

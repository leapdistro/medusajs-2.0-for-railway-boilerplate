import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add branch-specific cannabinoid % columns to product_attributes.
 *
 * Receiving stamps whichever field matches the product's flower branch
 * (cbd_percent for CBD flower, cbg_percent for CBG, thcp_percent for
 * THC-P). d9_percent is co-reported across every branch — drives the
 * Texas total-THC compliance line `(THCA × 0.877 + D9) < 0.3%` on
 * CBD/CBG PDPs + printed labels.
 *
 * Storefront adapter falls back to thca_percent when a branch-specific
 * field is null, so legacy THC-A records keep displaying unchanged.
 * All four columns are nullable — a THC-A product has no cbd_percent
 * and vice versa.
 */
export class Migration20260813000001 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "product_attributes" add column if not exists "cbd_percent" text null;`);
    this.addSql(`alter table "product_attributes" add column if not exists "cbg_percent" text null;`);
    this.addSql(`alter table "product_attributes" add column if not exists "thcp_percent" text null;`);
    this.addSql(`alter table "product_attributes" add column if not exists "d9_percent" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "product_attributes" drop column if exists "cbd_percent";`);
    this.addSql(`alter table "product_attributes" drop column if exists "cbg_percent";`);
    this.addSql(`alter table "product_attributes" drop column if exists "thcp_percent";`);
    this.addSql(`alter table "product_attributes" drop column if exists "d9_percent";`);
  }

}

import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add batch_id text column to product_attributes. Receiving's AI COA
 * extractor pulls the lab's Sample/Test/Batch ID from each uploaded
 * COA and writes it here; the label printer reads it for the new
 * "Batch" row.
 */
export class Migration20260610000001 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "product_attributes" add column if not exists "batch_id" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "product_attributes" drop column if exists "batch_id";`);
  }

}

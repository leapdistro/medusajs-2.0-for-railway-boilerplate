import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add qbo_bill_id + qbo_pushed_at columns to receiving_record so we can
 * mark which receivings have been pushed to QuickBooks (and link out to
 * the QBO Bill).
 *
 * Hand-written per the post-recovery rule — NOT db:generate.
 */
export class Migration20260512200000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE "receiving_record" ADD COLUMN IF NOT EXISTS "qbo_bill_id" text NULL;`);
    this.addSql(`ALTER TABLE "receiving_record" ADD COLUMN IF NOT EXISTS "qbo_pushed_at" text NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "receiving_record" DROP COLUMN IF EXISTS "qbo_bill_id";`);
    this.addSql(`ALTER TABLE "receiving_record" DROP COLUMN IF EXISTS "qbo_pushed_at";`);
  }

}

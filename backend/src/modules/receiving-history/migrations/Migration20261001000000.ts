import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add qbo_push_error + qbo_push_error_at to receiving_record so a failed
 * Bill push is visible on the receiving itself (it used to live only in
 * the server log + the operator's toast — receiving 20260930-114611852
 * failed silently on 2026-10-01).
 *
 * Hand-written per the post-recovery rule — NOT db:generate.
 */
export class Migration20261001000000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE "receiving_record" ADD COLUMN IF NOT EXISTS "qbo_push_error" text NULL;`);
    this.addSql(`ALTER TABLE "receiving_record" ADD COLUMN IF NOT EXISTS "qbo_push_error_at" text NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "receiving_record" DROP COLUMN IF EXISTS "qbo_push_error";`);
    this.addSql(`ALTER TABLE "receiving_record" DROP COLUMN IF EXISTS "qbo_push_error_at";`);
  }

}

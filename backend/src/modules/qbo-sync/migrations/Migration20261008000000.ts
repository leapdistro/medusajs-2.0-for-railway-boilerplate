import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * qbo_sync_job — durable queue behind the order → QBO invoice sync.
 * Hand-written per the post-recovery rule — NOT db:generate.
 * Railway deploys don't run migrations: apply by hand at deploy time.
 */
export class Migration20261008000000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "qbo_sync_job" ("id" text not null, "order_id" text not null, "status" text not null, "attempts" integer not null default 0, "next_attempt_at" timestamptz not null, "reasons" text not null, "last_error" text null, "last_error_code" text null, "started_at" timestamptz null, "finished_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "qbo_sync_job_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_qbo_sync_job_order_id" ON "qbo_sync_job" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_qbo_sync_job_due" ON "qbo_sync_job" ("status", "next_attempt_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_qbo_sync_job_deleted_at" ON "qbo_sync_job" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "qbo_sync_job" cascade;`);
  }

}

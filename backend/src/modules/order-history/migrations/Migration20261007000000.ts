import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * order_history_event — append-only log behind each order's History tab.
 * Hand-written per the post-recovery rule — NOT db:generate.
 * Railway deploys don't run migrations: apply by hand at deploy time.
 */
export class Migration20261007000000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "order_history_event" ("id" text not null, "order_id" text not null, "occurred_at" timestamptz not null, "actor_type" text not null, "actor_id" text null, "action" text not null, "summary" text not null, "details" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "order_history_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_history_event_order_id" ON "order_history_event" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_history_event_deleted_at" ON "order_history_event" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "order_history_event" cascade;`);
  }

}

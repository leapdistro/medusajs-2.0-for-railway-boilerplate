import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/* Hand-written per the post-recovery rule — DO NOT use medusa db:generate. */
export class Migration20260512190000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "qbo_connection" ("id" text not null, "realm_id" text not null, "environment" text not null, "access_token" text not null, "refresh_token" text not null, "access_expires_at" text not null, "refresh_expires_at" text not null, "company_name" text null, "last_bill_pushed_at" text null, "last_bill_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "qbo_connection_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_qbo_connection_deleted_at" ON "qbo_connection" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "qbo_connection" cascade;`);
  }

}

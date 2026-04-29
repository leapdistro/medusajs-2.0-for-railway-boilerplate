import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260429204707 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "receiving_draft" ("id" text not null, "payload" jsonb not null, "summary" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "receiving_draft_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_receiving_draft_deleted_at" ON "receiving_draft" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "receiving_draft" cascade;`);
  }

}

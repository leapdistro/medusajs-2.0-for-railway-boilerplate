import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/* Written by hand (not db:generate). Additive only: three new tables. */
export class Migration20261126000000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "marketing_campaign" ("id" text not null, "name" text not null, "subject" text not null default '', "preheader" text not null default '', "blocks" jsonb not null, "audience" jsonb not null, "status" text not null default 'draft', "scheduled_at" text null, "started_at" text null, "sent_at" text null, "recipient_count" integer not null default 0, "sent_count" integer not null default 0, "failed_count" integer not null default 0, "last_error" text null, "source" jsonb null, "created_by" text null, "last_test_at" text null, "locked_until" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "marketing_campaign_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_marketing_campaign_deleted_at" ON "marketing_campaign" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "marketing_recipient" ("id" text not null, "campaign_id" text not null, "customer_id" text null, "email" text not null, "status" text not null default 'queued', "message_id" text null, "error" text null, "sent_at" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "marketing_recipient_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_marketing_recipient_deleted_at" ON "marketing_recipient" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_marketing_recipient_campaign_id_email_unique" ON "marketing_recipient" ("campaign_id", "email") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_marketing_recipient_campaign_id_status" ON "marketing_recipient" ("campaign_id", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "marketing_suppression" ("id" text not null, "email" text not null, "reason" text not null, "campaign_id" text null, "note" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "marketing_suppression_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_marketing_suppression_deleted_at" ON "marketing_suppression" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_marketing_suppression_email_unique" ON "marketing_suppression" ("email") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "marketing_recipient" cascade;`);
    this.addSql(`drop table if exists "marketing_suppression" cascade;`);
    this.addSql(`drop table if exists "marketing_campaign" cascade;`);
  }

}

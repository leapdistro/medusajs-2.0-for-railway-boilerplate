import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260429235304 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "receiving_record" ("id" text not null, "invoice_number" text not null, "invoice_date" text not null, "supplier" jsonb not null, "shipping_total" text not null, "invoice_total" text not null, "total_qps" integer not null, "line_results" jsonb not null, "notes" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "receiving_record_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_receiving_record_deleted_at" ON "receiving_record" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "receiving_record" cascade;`);
  }

}

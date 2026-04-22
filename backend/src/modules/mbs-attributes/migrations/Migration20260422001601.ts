import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260422001601 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "product_attributes" ("id" text not null, "tier" text check ("tier" in ('classic', 'exotic', 'super', 'rapper', 'snow')) null, "strain_type" text check ("strain_type" in ('Indica', 'Sativa', 'Hybrid')) null, "cultivation" text check ("cultivation" in ('Indoor', 'Greenhouse', 'Outdoor', 'Hand-selected')) null, "best_for" text check ("best_for" in ('day', 'evening', 'night')) null, "potency" integer null, "thca_percent" text null, "total_cannabinoids_percent" text null, "effects" jsonb null, "coa_url" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "product_attributes_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_attributes_deleted_at" ON "product_attributes" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "product_attributes" cascade;`);
  }

}

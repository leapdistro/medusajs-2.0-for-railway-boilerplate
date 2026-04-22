import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260422005133 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "product_attributes" drop column if exists "cultivation";`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "product_attributes" add column if not exists "cultivation" text check ("cultivation" in ('Indoor', 'Greenhouse', 'Outdoor', 'Hand-selected')) null;`);
  }

}

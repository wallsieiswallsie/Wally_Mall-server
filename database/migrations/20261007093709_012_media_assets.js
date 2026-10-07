// Managed product images retain their permanent URL in PostgreSQL; legacy URLs
// remain valid because product_media.media_asset_id is nullable.
export async function up(knex) {
  await knex.schema.createTable("media_assets", (table) => {
    table.uuid("id").primary();
    table.uuid("owner_id").notNullable()
      .references("id").inTable("users").onDelete("RESTRICT");
    table.string("source", 30).notNullable();
    table.string("purpose", 30).notNullable();
    table.string("bucket", 222).notNullable();
    table.text("object_key").notNullable().unique();
    table.text("public_url").notNullable().unique();
    table.string("original_filename", 255).notNullable();
    table.string("content_type", 50).notNullable();
    table.integer("size_bytes").notNullable();
    table.string("status", 20).notNullable();
    table.text("generation");
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("purged_at", { useTz: true });
    table.index(["owner_id", "status"], "idx_media_assets_owner_status");
    table.index(["expires_at", "status"], "idx_media_assets_expiry");
  });
  await knex.raw(`
    ALTER TABLE media_assets
      ADD CONSTRAINT chk_media_assets_source CHECK (source IN ('device', 'google_drive')),
      ADD CONSTRAINT chk_media_assets_purpose CHECK (purpose = 'product'),
      ADD CONSTRAINT chk_media_assets_type CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
      ADD CONSTRAINT chk_media_assets_size CHECK (size_bytes BETWEEN 1 AND 5242880),
      ADD CONSTRAINT chk_media_assets_status CHECK (status IN ('pending', 'uploaded', 'attached', 'deleted')),
      ADD CONSTRAINT chk_media_assets_bucket CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$'),
      ADD CONSTRAINT chk_media_assets_key CHECK (object_key ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(jpg|png|webp)$'),
      ADD CONSTRAINT chk_media_assets_url CHECK
        (public_url = 'https://storage.googleapis.com/' || bucket || '/' || object_key);
  `);
  await knex.schema.alterTable("product_media", (table) => {
    table.uuid("media_asset_id").nullable();
    table.foreign("media_asset_id", "fk_product_media_asset")
      .references("id").inTable("media_assets").onDelete("RESTRICT");
    table.unique("media_asset_id", "uq_product_media_asset");
  });
  await knex.raw(`
    ALTER TABLE product_media ADD CONSTRAINT chk_product_media_managed_url CHECK
      (media_asset_id IS NULL OR
        (url LIKE 'https://storage.googleapis.com/%'
         AND position(chr(63) in url) = 0
         AND position('#' in url) = 0));
  `);
}

export async function down(knex) {
  await knex.raw("ALTER TABLE product_media DROP CONSTRAINT IF EXISTS chk_product_media_managed_url");
  await knex.schema.alterTable("product_media", (table) => {
    table.dropUnique("media_asset_id", "uq_product_media_asset");
    table.dropForeign("media_asset_id", "fk_product_media_asset");
    table.dropColumn("media_asset_id");
  });
  await knex.schema.dropTableIfExists("media_assets");
}

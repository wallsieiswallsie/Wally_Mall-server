/**
 * 004_inventory.js
 * Wally Mall - Inventory & stock movement
 */

export async function up(knex) {
  await knex.schema.createTable('inventories', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('variant_id').notNullable();
    table.uuid('store_address_id');
    table.integer('on_hand').notNullable().defaultTo(0);
    table.integer('reserved').notNullable().defaultTo(0);
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('variant_id', 'fk_inventories_variant')
      .references('id').inTable('product_variants')
      .onDelete('RESTRICT');
    table.foreign('store_address_id', 'fk_inventories_store_address')
      .references('id').inTable('store_addresses')
      .onDelete('SET NULL');

    table.index(['variant_id'], 'idx_inventories_variant_id');
  });

  // PostgreSQL UNIQUE treats NULL values as distinct, so use two partial indexes.
  await knex.raw(`
    CREATE UNIQUE INDEX uq_inventories_variant_location
      ON inventories (variant_id, store_address_id)
      WHERE store_address_id IS NOT NULL;

    CREATE UNIQUE INDEX uq_inventories_variant_default_location
      ON inventories (variant_id)
      WHERE store_address_id IS NULL;

    ALTER TABLE inventories
      ADD CONSTRAINT chk_inventories_on_hand CHECK (on_hand >= 0),
      ADD CONSTRAINT chk_inventories_reserved CHECK (reserved >= 0),
      ADD CONSTRAINT chk_inventories_reserved_lte_on_hand CHECK (reserved <= on_hand);
  `);

  await knex.schema.createTable('inventory_movements', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('variant_id').notNullable();
    table.string('type', 30).notNullable();
    table.integer('quantity').notNullable();
    table.string('reference_type', 50);
    table.uuid('reference_id');
    table.integer('before_quantity');
    table.integer('after_quantity');
    table.uuid('actor_id');
    table.text('reason');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('variant_id', 'fk_inventory_movements_variant')
      .references('id').inTable('product_variants')
      .onDelete('RESTRICT');
    table.foreign('actor_id', 'fk_inventory_movements_actor')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['variant_id'], 'idx_inventory_movements_variant_id');
    table.index(['reference_type', 'reference_id'], 'idx_inventory_movements_reference');
    table.index(['created_at'], 'idx_inventory_movements_created_at');
  });

  await knex.raw(`
    ALTER TABLE inventory_movements
      ADD CONSTRAINT chk_inventory_movements_type
      CHECK (type IN ('restock', 'reserve', 'release', 'sale', 'return', 'adjustment')),
      ADD CONSTRAINT chk_inventory_movements_quantity_nonzero
      CHECK (quantity <> 0),
      ADD CONSTRAINT chk_inventory_movements_before_nonnegative
      CHECK (before_quantity IS NULL OR before_quantity >= 0),
      ADD CONSTRAINT chk_inventory_movements_after_nonnegative
      CHECK (after_quantity IS NULL OR after_quantity >= 0);
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('inventory_movements');
  await knex.schema.dropTableIfExists('inventories');
}
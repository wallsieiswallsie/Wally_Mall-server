/**
 * 005_cart.js
 * Wally Mall - Cart & favorites
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE cart_status AS ENUM ('active', 'converted', 'abandoned');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('carts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.specificType('status', 'cart_status').notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_carts_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');

    table.index(['user_id'], 'idx_carts_user_id');
    table.index(['status'], 'idx_carts_status');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_carts_one_active_per_user
      ON carts (user_id)
      WHERE status = 'active';
  `);

  await knex.schema.createTable('cart_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('cart_id').notNullable();
    table.uuid('variant_id').notNullable();
    table.integer('quantity').notNullable();
    table.timestamp('added_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('cart_id', 'fk_cart_items_cart')
      .references('id').inTable('carts')
      .onDelete('CASCADE');
    table.foreign('variant_id', 'fk_cart_items_variant')
      .references('id').inTable('product_variants')
      .onDelete('RESTRICT');

    table.unique(['cart_id', 'variant_id'], 'uq_cart_items_cart_variant');
    table.index(['cart_id'], 'idx_cart_items_cart_id');
  });

  await knex.raw(`
    ALTER TABLE cart_items
      ADD CONSTRAINT chk_cart_items_quantity CHECK (quantity > 0);
  `);

  await knex.schema.createTable('favorites', (table) => {
    table.uuid('user_id').notNullable();
    table.uuid('product_id').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['user_id', 'product_id'], 'pk_favorites');
    table.foreign('user_id', 'fk_favorites_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');
    table.foreign('product_id', 'fk_favorites_product')
      .references('id').inTable('products')
      .onDelete('CASCADE');

    table.index(['product_id'], 'idx_favorites_product_id');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('favorites');
  await knex.schema.dropTableIfExists('cart_items');
  await knex.schema.dropTableIfExists('carts');
  await knex.raw('DROP TYPE IF EXISTS cart_status;');
}
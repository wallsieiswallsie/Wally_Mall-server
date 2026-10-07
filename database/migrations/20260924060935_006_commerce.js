/**
 * 006_commerce.js
 * Wally Mall - Checkout, multi-store orders, promotions
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE checkout_status AS ENUM ('pending_payment', 'paid', 'expired', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE order_status AS ENUM (
        'awaiting_payment',
        'confirmed',
        'processing',
        'ready',
        'in_delivery',
        'completed',
        'cancelled'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE fulfillment_type AS ENUM ('pickup', 'seller_delivery', 'wally_local');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('checkouts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('checkout_number', 50).notNullable().unique();
    table.uuid('buyer_id').notNullable();
    table.bigInteger('subtotal').notNullable().defaultTo(0);
    table.bigInteger('delivery_total').notNullable().defaultTo(0);
    table.bigInteger('service_fee_total').notNullable().defaultTo(0);
    table.bigInteger('discount_total').notNullable().defaultTo(0);
    table.bigInteger('grand_total').notNullable();
    table.string('currency', 3).notNullable().defaultTo('IDR');
    table.specificType('status', 'checkout_status').notNullable().defaultTo('pending_payment');
    table.timestamp('expires_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('buyer_id', 'fk_checkouts_buyer')
      .references('id').inTable('users')
      .onDelete('RESTRICT');

    table.index(['buyer_id'], 'idx_checkouts_buyer_id');
    table.index(['status'], 'idx_checkouts_status');
    table.index(['created_at'], 'idx_checkouts_created_at');
  });

  await knex.raw(`
    ALTER TABLE checkouts
      ADD CONSTRAINT chk_checkouts_money CHECK (
        subtotal >= 0
        AND delivery_total >= 0
        AND service_fee_total >= 0
        AND discount_total >= 0
        AND grand_total >= 0
      ),
      ADD CONSTRAINT chk_checkouts_currency CHECK (char_length(currency) = 3);
  `);

  await knex.schema.createTable('orders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('order_number', 50).notNullable().unique();
    table.uuid('checkout_id').notNullable();
    table.uuid('buyer_id').notNullable();
    table.uuid('store_id').notNullable();
    table.specificType('status', 'order_status').notNullable().defaultTo('awaiting_payment');
    table.specificType('fulfillment_type', 'fulfillment_type').notNullable();
    table.bigInteger('subtotal').notNullable();
    table.bigInteger('delivery_fee').notNullable().defaultTo(0);
    table.bigInteger('service_fee').notNullable().defaultTo(0);
    table.bigInteger('discount_amount').notNullable().defaultTo(0);
    table.bigInteger('platform_fee').notNullable().defaultTo(0);
    table.bigInteger('gateway_fee').notNullable().defaultTo(0);
    table.bigInteger('seller_net_amount').notNullable().defaultTo(0);
    table.bigInteger('total_amount').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('paid_at', { useTz: true });
    table.timestamp('completed_at', { useTz: true });
    table.timestamp('cancelled_at', { useTz: true });

    table.foreign('checkout_id', 'fk_orders_checkout')
      .references('id').inTable('checkouts')
      .onDelete('RESTRICT');
    table.foreign('buyer_id', 'fk_orders_buyer')
      .references('id').inTable('users')
      .onDelete('RESTRICT');
    table.foreign('store_id', 'fk_orders_store')
      .references('id').inTable('stores')
      .onDelete('RESTRICT');

    table.index(['checkout_id'], 'idx_orders_checkout_id');
    table.index(['buyer_id'], 'idx_orders_buyer_id');
    table.index(['store_id'], 'idx_orders_store_id');
    table.index(['status'], 'idx_orders_status');
    table.index(['created_at'], 'idx_orders_created_at');
  });

  await knex.raw(`
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_money CHECK (
        subtotal >= 0
        AND delivery_fee >= 0
        AND service_fee >= 0
        AND discount_amount >= 0
        AND platform_fee >= 0
        AND gateway_fee >= 0
        AND seller_net_amount >= 0
        AND total_amount >= 0
      );
  `);

  await knex.schema.createTable('order_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable();
    table.uuid('product_id');
    table.uuid('variant_id');
    table.string('product_name', 200).notNullable();
    table.string('variant_name', 150);
    table.string('sku', 100);
    table.bigInteger('unit_price').notNullable();
    table.integer('quantity').notNullable();
    table.bigInteger('subtotal').notNullable();
    table.text('product_image_url');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('order_id', 'fk_order_items_order')
      .references('id').inTable('orders')
      .onDelete('RESTRICT');
    table.foreign('product_id', 'fk_order_items_product')
      .references('id').inTable('products')
      .onDelete('SET NULL');
    table.foreign('variant_id', 'fk_order_items_variant')
      .references('id').inTable('product_variants')
      .onDelete('SET NULL');

    table.index(['order_id'], 'idx_order_items_order_id');
    table.index(['product_id'], 'idx_order_items_product_id');
    table.index(['variant_id'], 'idx_order_items_variant_id');
  });

  await knex.raw(`
    ALTER TABLE order_items
      ADD CONSTRAINT chk_order_items_unit_price CHECK (unit_price >= 0),
      ADD CONSTRAINT chk_order_items_quantity CHECK (quantity > 0),
      ADD CONSTRAINT chk_order_items_subtotal CHECK (subtotal >= 0);
  `);

  await knex.schema.createTable('order_addresses', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable().unique();
    table.string('recipient_name', 120).notNullable();
    table.string('phone', 30).notNullable();
    table.string('province', 120).notNullable();
    table.string('city', 120).notNullable();
    table.string('district', 120);
    table.string('subdistrict', 120);
    table.string('postal_code', 10);
    table.text('address_line').notNullable();
    table.text('landmark');
    table.decimal('latitude', 10, 7);
    table.decimal('longitude', 10, 7);
    table.text('notes');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('order_id', 'fk_order_addresses_order')
      .references('id').inTable('orders')
      .onDelete('RESTRICT');
  });

  await knex.raw(`
    ALTER TABLE order_addresses
      ADD CONSTRAINT chk_order_addresses_latitude
      CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
      ADD CONSTRAINT chk_order_addresses_longitude
      CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
  `);

  await knex.schema.createTable('order_status_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable();
    table.specificType('from_status', 'order_status');
    table.specificType('to_status', 'order_status').notNullable();
    table.string('actor_type', 30).notNullable();
    table.uuid('actor_id');
    table.text('reason');
    table.jsonb('metadata');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('order_id', 'fk_order_status_history_order')
      .references('id').inTable('orders')
      .onDelete('RESTRICT');
    table.foreign('actor_id', 'fk_order_status_history_actor')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['order_id'], 'idx_order_status_history_order_id');
    table.index(['created_at'], 'idx_order_status_history_created_at');
  });

  await knex.raw(`
    ALTER TABLE order_status_history
      ADD CONSTRAINT chk_order_status_history_actor_type
      CHECK (actor_type IN ('buyer', 'seller', 'admin', 'super_admin', 'system'));
  `);

  await knex.schema.createTable('promotions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 150).notNullable();
    table.string('type', 30).notNullable();
    table.bigInteger('value').notNullable();
    table.bigInteger('minimum_order').notNullable().defaultTo(0);
    table.bigInteger('maximum_discount');
    table.timestamp('start_at', { useTz: true }).notNullable();
    table.timestamp('end_at', { useTz: true }).notNullable();
    table.string('status', 30).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['status'], 'idx_promotions_status');
    table.index(['start_at'], 'idx_promotions_start_at');
    table.index(['end_at'], 'idx_promotions_end_at');
  });

  await knex.raw(`
    ALTER TABLE promotions
      ADD CONSTRAINT chk_promotions_type CHECK (type IN ('fixed', 'percentage')),
      ADD CONSTRAINT chk_promotions_value CHECK (value >= 0),
      ADD CONSTRAINT chk_promotions_minimum_order CHECK (minimum_order >= 0),
      ADD CONSTRAINT chk_promotions_maximum_discount CHECK (maximum_discount IS NULL OR maximum_discount >= 0),
      ADD CONSTRAINT chk_promotions_period CHECK (end_at > start_at),
      ADD CONSTRAINT chk_promotions_status CHECK (status IN ('draft', 'scheduled', 'active', 'expired', 'disabled'));
  `);

  await knex.schema.createTable('promo_codes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('promotion_id').notNullable();
    table.specificType('code', 'citext').notNullable().unique();
    table.integer('usage_limit');
    table.integer('usage_per_user');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('promotion_id', 'fk_promo_codes_promotion')
      .references('id').inTable('promotions')
      .onDelete('CASCADE');

    table.index(['promotion_id'], 'idx_promo_codes_promotion_id');
  });

  await knex.raw(`
    ALTER TABLE promo_codes
      ADD CONSTRAINT chk_promo_codes_usage_limit CHECK (usage_limit IS NULL OR usage_limit > 0),
      ADD CONSTRAINT chk_promo_codes_usage_per_user CHECK (usage_per_user IS NULL OR usage_per_user > 0);
  `);

  await knex.schema.createTable('promotion_usages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('promotion_id').notNullable();
    table.uuid('promo_code_id');
    table.uuid('user_id').notNullable();
    table.uuid('checkout_id').notNullable();
    table.bigInteger('discount_amount').notNullable();
    table.timestamp('used_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('promotion_id', 'fk_promotion_usages_promotion')
      .references('id').inTable('promotions')
      .onDelete('RESTRICT');
    table.foreign('promo_code_id', 'fk_promotion_usages_promo_code')
      .references('id').inTable('promo_codes')
      .onDelete('SET NULL');
    table.foreign('user_id', 'fk_promotion_usages_user')
      .references('id').inTable('users')
      .onDelete('RESTRICT');
    table.foreign('checkout_id', 'fk_promotion_usages_checkout')
      .references('id').inTable('checkouts')
      .onDelete('RESTRICT');

    table.index(['promotion_id'], 'idx_promotion_usages_promotion_id');
    table.index(['user_id'], 'idx_promotion_usages_user_id');
    table.index(['checkout_id'], 'idx_promotion_usages_checkout_id');
  });

  await knex.raw(`
    ALTER TABLE promotion_usages
      ADD CONSTRAINT chk_promotion_usages_discount CHECK (discount_amount >= 0);
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('promotion_usages');
  await knex.schema.dropTableIfExists('promo_codes');
  await knex.schema.dropTableIfExists('promotions');
  await knex.schema.dropTableIfExists('order_status_history');
  await knex.schema.dropTableIfExists('order_addresses');
  await knex.schema.dropTableIfExists('order_items');
  await knex.schema.dropTableIfExists('orders');
  await knex.schema.dropTableIfExists('checkouts');

  await knex.raw('DROP TYPE IF EXISTS fulfillment_type;');
  await knex.raw('DROP TYPE IF EXISTS order_status;');
  await knex.raw('DROP TYPE IF EXISTS checkout_status;');
}
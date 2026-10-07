/**
 * 008_fulfillment.js
 * Wally Mall - Pickup, seller delivery, Wally local delivery
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE fulfillment_status AS ENUM (
        'pending',
        'processing',
        'ready',
        'picked_up',
        'in_delivery',
        'delivered',
        'cancelled'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('fulfillments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable();
    table.specificType('type', 'fulfillment_type').notNullable();
    table.specificType('status', 'fulfillment_status').notNullable().defaultTo('pending');
    table.string('courier_name', 120);
    table.string('courier_phone', 30);
    table.string('tracking_number', 150);
    table.string('pickup_code', 50);
    table.timestamp('estimated_at', { useTz: true });
    table.timestamp('dispatched_at', { useTz: true });
    table.timestamp('delivered_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('order_id', 'fk_fulfillments_order')
      .references('id').inTable('orders')
      .onDelete('RESTRICT');

    table.index(['order_id'], 'idx_fulfillments_order_id');
    table.index(['status'], 'idx_fulfillments_status');
    table.index(['tracking_number'], 'idx_fulfillments_tracking_number');
  });


  await knex.schema.createTable('fulfillment_status_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('fulfillment_id').notNullable();
    table.specificType('from_status', 'fulfillment_status');
    table.specificType('to_status', 'fulfillment_status').notNullable();
    table.uuid('actor_id');
    table.text('notes');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('fulfillment_id', 'fk_fulfillment_status_history_fulfillment')
      .references('id').inTable('fulfillments')
      .onDelete('RESTRICT');
    table.foreign('actor_id', 'fk_fulfillment_status_history_actor')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['fulfillment_id'], 'idx_fulfillment_status_history_fulfillment_id');
    table.index(['created_at'], 'idx_fulfillment_status_history_created_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('fulfillment_status_history');
  await knex.schema.dropTableIfExists('fulfillments');
  await knex.raw('DROP TYPE IF EXISTS fulfillment_status;');
}
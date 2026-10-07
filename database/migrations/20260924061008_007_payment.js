/**
 * 007_payment.js
 * Wally Mall - Payment, provider events, refunds
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE payment_status AS ENUM (
        'pending',
        'success',
        'failed',
        'expired',
        'partially_refunded',
        'refunded'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE refund_status AS ENUM ('requested', 'processing', 'success', 'failed', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('payments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('checkout_id').notNullable();
    table.string('provider', 50).notNullable();
    table.string('method', 50).notNullable();
    table.bigInteger('amount').notNullable();
    table.string('currency', 3).notNullable().defaultTo('IDR');
    table.specificType('status', 'payment_status').notNullable().defaultTo('pending');
    table.string('provider_reference', 255);
    table.timestamp('expires_at', { useTz: true });
    table.timestamp('paid_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('checkout_id', 'fk_payments_checkout')
      .references('id').inTable('checkouts')
      .onDelete('RESTRICT');

    table.index(['checkout_id'], 'idx_payments_checkout_id');
    table.index(['provider_reference'], 'idx_payments_provider_reference');
    table.index(['status'], 'idx_payments_status');
    table.index(['created_at'], 'idx_payments_created_at');
  });

  await knex.raw(`
    ALTER TABLE payments
      ADD CONSTRAINT chk_payments_amount CHECK (amount >= 0),
      ADD CONSTRAINT chk_payments_currency CHECK (char_length(currency) = 3);

    CREATE UNIQUE INDEX uq_payments_provider_reference
      ON payments (provider, provider_reference)
      WHERE provider_reference IS NOT NULL;
  `);

  await knex.schema.createTable('payment_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('payment_id');
    table.string('provider', 50).notNullable();
    table.string('provider_event_id', 255).notNullable();
    table.string('event_type', 100).notNullable();
    table.jsonb('payload').notNullable();
    table.boolean('signature_valid').notNullable().defaultTo(false);
    table.timestamp('processed_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('payment_id', 'fk_payment_events_payment')
      .references('id').inTable('payments')
      .onDelete('SET NULL');

    table.unique(['provider', 'provider_event_id'], 'uq_payment_events_provider_event');
    table.index(['payment_id'], 'idx_payment_events_payment_id');
    table.index(['created_at'], 'idx_payment_events_created_at');
  });

  await knex.schema.createTable('refunds', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable();
    table.uuid('payment_id').notNullable();
    table.bigInteger('amount').notNullable();
    table.text('reason').notNullable();
    table.specificType('status', 'refund_status').notNullable().defaultTo('requested');
    table.uuid('requested_by');
    table.uuid('approved_by');
    table.string('provider_reference', 255);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('processed_at', { useTz: true });

    table.foreign('order_id', 'fk_refunds_order')
      .references('id').inTable('orders')
      .onDelete('RESTRICT');
    table.foreign('payment_id', 'fk_refunds_payment')
      .references('id').inTable('payments')
      .onDelete('RESTRICT');
    table.foreign('requested_by', 'fk_refunds_requested_by')
      .references('id').inTable('users')
      .onDelete('SET NULL');
    table.foreign('approved_by', 'fk_refunds_approved_by')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['order_id'], 'idx_refunds_order_id');
    table.index(['payment_id'], 'idx_refunds_payment_id');
    table.index(['status'], 'idx_refunds_status');
  });

  await knex.raw(`
    ALTER TABLE refunds
      ADD CONSTRAINT chk_refunds_amount CHECK (amount > 0);
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('refunds');
  await knex.schema.dropTableIfExists('payment_events');
  await knex.schema.dropTableIfExists('payments');

  await knex.raw('DROP TYPE IF EXISTS refund_status;');
  await knex.raw('DROP TYPE IF EXISTS payment_status;');
}
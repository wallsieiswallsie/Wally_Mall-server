/**
 * 010_finance.js
 * Wally Mall - Platform fee, seller ledger, bank accounts, payouts
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE payout_status AS ENUM ('requested', 'processing', 'paid', 'failed');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE ledger_direction AS ENUM ('credit', 'debit');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('platform_fee_rules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 150).notNullable();
    table.decimal('percentage', 8, 4).notNullable().defaultTo(0);
    table.bigInteger('fixed_amount').notNullable().defaultTo(0);
    table.string('scope_type', 30).notNullable().defaultTo('global');
    table.uuid('scope_id');
    table.timestamp('effective_from', { useTz: true }).notNullable();
    table.timestamp('effective_until', { useTz: true });
    table.string('status', 30).notNullable();
    table.uuid('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('created_by', 'fk_platform_fee_rules_created_by')
      .references('id').inTable('users')
      .onDelete('RESTRICT');

    table.index(['status'], 'idx_platform_fee_rules_status');
    table.index(['effective_from'], 'idx_platform_fee_rules_effective_from');
    table.index(['scope_type', 'scope_id'], 'idx_platform_fee_rules_scope');
  });

  await knex.raw(`
    ALTER TABLE platform_fee_rules
      ADD CONSTRAINT chk_platform_fee_rules_percentage CHECK (percentage BETWEEN 0 AND 100),
      ADD CONSTRAINT chk_platform_fee_rules_fixed_amount CHECK (fixed_amount >= 0),
      ADD CONSTRAINT chk_platform_fee_rules_scope CHECK (scope_type IN ('global', 'category', 'store')),
      ADD CONSTRAINT chk_platform_fee_rules_period CHECK (
        effective_until IS NULL OR effective_until > effective_from
      ),
      ADD CONSTRAINT chk_platform_fee_rules_status CHECK (
        status IN ('scheduled', 'active', 'expired', 'disabled')
      );
  `);

  await knex.schema.createTable('order_fees', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_id').notNullable();
    table.string('fee_type', 50).notNullable();
    table.uuid('rule_id');
    table.bigInteger('amount').notNullable();
    table.decimal('percentage_snapshot', 8, 4);
    table.bigInteger('fixed_snapshot');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('order_id', 'fk_order_fees_order')
      .references('id').inTable('orders')
      .onDelete('RESTRICT');
    table.foreign('rule_id', 'fk_order_fees_rule')
      .references('id').inTable('platform_fee_rules')
      .onDelete('SET NULL');

    table.index(['order_id'], 'idx_order_fees_order_id');
    table.index(['fee_type'], 'idx_order_fees_fee_type');
  });

  await knex.raw(`
    ALTER TABLE order_fees
      ADD CONSTRAINT chk_order_fees_amount CHECK (amount >= 0),
      ADD CONSTRAINT chk_order_fees_percentage CHECK (
        percentage_snapshot IS NULL OR percentage_snapshot BETWEEN 0 AND 100
      ),
      ADD CONSTRAINT chk_order_fees_fixed CHECK (fixed_snapshot IS NULL OR fixed_snapshot >= 0);
  `);

  await knex.schema.createTable('store_bank_accounts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable();
    table.string('bank_code', 30).notNullable();
    table.text('account_number_encrypted').notNullable();
    table.string('account_holder', 150).notNullable();
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.timestamp('verified_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('store_id', 'fk_store_bank_accounts_store')
      .references('id').inTable('stores')
      .onDelete('RESTRICT');

    table.index(['store_id'], 'idx_store_bank_accounts_store_id');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_store_bank_accounts_primary
      ON store_bank_accounts (store_id)
      WHERE is_primary = true;
  `);

  await knex.schema.createTable('seller_ledger', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable();
    table.uuid('order_id');
    table.string('type', 50).notNullable();
    table.specificType('direction', 'ledger_direction').notNullable();
    table.bigInteger('amount').notNullable();
    table.bigInteger('balance_after').notNullable();
    table.uuid('reference_id');
    table.text('description');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('store_id', 'fk_seller_ledger_store')
      .references('id').inTable('stores')
      .onDelete('RESTRICT');
    table.foreign('order_id', 'fk_seller_ledger_order')
      .references('id').inTable('orders')
      .onDelete('SET NULL');

    table.index(['store_id'], 'idx_seller_ledger_store_id');
    table.index(['order_id'], 'idx_seller_ledger_order_id');
    table.index(['created_at'], 'idx_seller_ledger_created_at');
  });

  await knex.raw(`
    ALTER TABLE seller_ledger
      ADD CONSTRAINT chk_seller_ledger_type
      CHECK (type IN ('sale', 'refund', 'platform_fee', 'payout', 'adjustment')),
      ADD CONSTRAINT chk_seller_ledger_amount CHECK (amount > 0);
  `);

  await knex.schema.createTable('seller_payouts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable();
    table.uuid('bank_account_id').notNullable();
    table.bigInteger('amount').notNullable();
    table.specificType('status', 'payout_status').notNullable().defaultTo('requested');
    table.string('provider_reference', 255);
    table.timestamp('requested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('processed_at', { useTz: true });

    table.foreign('store_id', 'fk_seller_payouts_store')
      .references('id').inTable('stores')
      .onDelete('RESTRICT');
    table.foreign('bank_account_id', 'fk_seller_payouts_bank_account')
      .references('id').inTable('store_bank_accounts')
      .onDelete('RESTRICT');

    table.index(['store_id'], 'idx_seller_payouts_store_id');
    table.index(['status'], 'idx_seller_payouts_status');
  });

  await knex.raw(`
    ALTER TABLE seller_payouts
      ADD CONSTRAINT chk_seller_payouts_amount CHECK (amount > 0);

    CREATE UNIQUE INDEX uq_seller_payouts_provider_reference
      ON seller_payouts (provider_reference)
      WHERE provider_reference IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('seller_payouts');
  await knex.schema.dropTableIfExists('seller_ledger');
  await knex.schema.dropTableIfExists('store_bank_accounts');
  await knex.schema.dropTableIfExists('order_fees');
  await knex.schema.dropTableIfExists('platform_fee_rules');

  await knex.raw('DROP TYPE IF EXISTS ledger_direction;');
  await knex.raw('DROP TYPE IF EXISTS payout_status;');
}
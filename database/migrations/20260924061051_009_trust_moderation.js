/**
 * 009_trust_moderation.js
 * Wally Mall - Reviews, reports, moderation, notifications, audit logs
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE report_status AS ENUM ('open', 'reviewing', 'resolved', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('reviews', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('order_item_id').notNullable().unique();
    table.uuid('buyer_id').notNullable();
    table.uuid('product_id').notNullable();
    table.uuid('store_id').notNullable();
    table.integer('rating').notNullable();
    table.text('comment');
    table.string('status', 30).notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('order_item_id', 'fk_reviews_order_item')
      .references('id').inTable('order_items')
      .onDelete('RESTRICT');
    table.foreign('buyer_id', 'fk_reviews_buyer')
      .references('id').inTable('users')
      .onDelete('RESTRICT');
    table.foreign('product_id', 'fk_reviews_product')
      .references('id').inTable('products')
      .onDelete('RESTRICT');
    table.foreign('store_id', 'fk_reviews_store')
      .references('id').inTable('stores')
      .onDelete('RESTRICT');

    table.index(['product_id'], 'idx_reviews_product_id');
    table.index(['store_id'], 'idx_reviews_store_id');
    table.index(['buyer_id'], 'idx_reviews_buyer_id');
  });

  await knex.raw(`
    ALTER TABLE reviews
      ADD CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5),
      ADD CONSTRAINT chk_reviews_status CHECK (status IN ('active', 'hidden'));
  `);

  await knex.schema.createTable('reports', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('reporter_id');
    table.string('target_type', 50).notNullable();
    table.uuid('target_id').notNullable();
    table.string('category', 100).notNullable();
    table.text('description').notNullable();
    table.specificType('status', 'report_status').notNullable().defaultTo('open');
    table.uuid('assigned_admin_id');
    table.text('resolution');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('resolved_at', { useTz: true });

    table.foreign('reporter_id', 'fk_reports_reporter')
      .references('id').inTable('users')
      .onDelete('SET NULL');
    table.foreign('assigned_admin_id', 'fk_reports_assigned_admin')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['reporter_id'], 'idx_reports_reporter_id');
    table.index(['target_type', 'target_id'], 'idx_reports_target');
    table.index(['status'], 'idx_reports_status');
    table.index(['assigned_admin_id'], 'idx_reports_assigned_admin_id');
  });

  await knex.schema.createTable('moderation_actions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('target_type', 50).notNullable();
    table.uuid('target_id').notNullable();
    table.string('action', 50).notNullable();
    table.text('reason').notNullable();
    table.uuid('performed_by').notNullable();
    table.jsonb('previous_state');
    table.jsonb('new_state');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('performed_by', 'fk_moderation_actions_performed_by')
      .references('id').inTable('users')
      .onDelete('RESTRICT');

    table.index(['target_type', 'target_id'], 'idx_moderation_actions_target');
    table.index(['performed_by'], 'idx_moderation_actions_performed_by');
    table.index(['created_at'], 'idx_moderation_actions_created_at');
  });

  await knex.schema.createTable('notifications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.string('type', 50).notNullable();
    table.string('title', 200).notNullable();
    table.text('body').notNullable();
    table.string('reference_type', 50);
    table.uuid('reference_id');
    table.string('channel', 30).notNullable().defaultTo('in_app');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_notifications_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');

    table.index(['user_id'], 'idx_notifications_user_id');
    table.index(['created_at'], 'idx_notifications_created_at');
  });

  await knex.raw(`
    ALTER TABLE notifications
      ADD CONSTRAINT chk_notifications_channel
      CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push'));
  `);

  await knex.schema.createTable('notification_reads', (table) => {
    table.uuid('notification_id').notNullable();
    table.uuid('user_id').notNullable();
    table.timestamp('read_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['notification_id', 'user_id'], 'pk_notification_reads');
    table.foreign('notification_id', 'fk_notification_reads_notification')
      .references('id').inTable('notifications')
      .onDelete('CASCADE');
    table.foreign('user_id', 'fk_notification_reads_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');

    table.index(['user_id'], 'idx_notification_reads_user_id');
  });

  await knex.schema.createTable('audit_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('actor_id');
    table.string('actor_role', 50);
    table.string('action', 100).notNullable();
    table.string('entity_type', 50).notNullable();
    table.uuid('entity_id');
    table.text('reason');
    table.jsonb('before_data');
    table.jsonb('after_data');
    table.specificType('ip_address', 'inet');
    table.text('user_agent');
    table.uuid('request_id');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('actor_id', 'fk_audit_logs_actor')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['actor_id'], 'idx_audit_logs_actor_id');
    table.index(['entity_type', 'entity_id'], 'idx_audit_logs_entity');
    table.index(['action'], 'idx_audit_logs_action');
    table.index(['created_at'], 'idx_audit_logs_created_at');
    table.index(['request_id'], 'idx_audit_logs_request_id');
  });

  // Guard append-only audit history at DB level for ordinary application access.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs are append-only';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_audit_logs_no_update
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

    CREATE TRIGGER trg_audit_logs_no_delete
      BEFORE DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
  `);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete ON audit_logs;');
  await knex.raw('DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;');
  await knex.raw('DROP FUNCTION IF EXISTS prevent_audit_log_mutation();');

  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('notification_reads');
  await knex.schema.dropTableIfExists('notifications');
  await knex.schema.dropTableIfExists('moderation_actions');
  await knex.schema.dropTableIfExists('reports');
  await knex.schema.dropTableIfExists('reviews');

  await knex.raw('DROP TYPE IF EXISTS report_status;');
}
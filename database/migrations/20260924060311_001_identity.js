/**
 * 001_identity.js
 * Wally Mall - Identity & Authentication
 * PostgreSQL + Knex (ESM)
 */

export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "citext";');

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE user_status AS ENUM ('active', 'suspended', 'blocked', 'deleted');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('public_id', 30).notNullable().unique();
    table.string('name', 120).notNullable();
    table.specificType('email', 'citext').notNullable().unique();
    table.string('phone', 30).unique();
    table.text('password_hash').notNullable();
    table.text('avatar_url');
    table.specificType('status', 'user_status').notNullable().defaultTo('active');
    table.timestamp('email_verified_at', { useTz: true });
    table.timestamp('phone_verified_at', { useTz: true });
    table.timestamp('last_login_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true });

    table.index(['status'], 'idx_users_status');
    table.index(['created_at'], 'idx_users_created_at');
  });

  await knex.schema.createTable('roles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('code', 50).notNullable().unique();
    table.string('name', 100).notNullable();
    table.text('description');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('user_roles', (table) => {
    table.uuid('user_id').notNullable();
    table.uuid('role_id').notNullable();
    table.uuid('assigned_by');
    table.timestamp('assigned_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('revoked_at', { useTz: true });

    table.primary(['user_id', 'role_id'], 'pk_user_roles');
    table.foreign('user_id', 'fk_user_roles_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');
    table.foreign('role_id', 'fk_user_roles_role')
      .references('id').inTable('roles')
      .onDelete('RESTRICT');
    table.foreign('assigned_by', 'fk_user_roles_assigned_by')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['role_id'], 'idx_user_roles_role_id');
    table.index(['revoked_at'], 'idx_user_roles_revoked_at');
  });

  await knex.schema.createTable('user_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.text('refresh_token_hash').notNullable();
    table.string('device_name', 150);
    table.specificType('ip_address', 'inet');
    table.text('user_agent');
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('revoked_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_user_sessions_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');

    table.index(['user_id'], 'idx_user_sessions_user_id');
    table.index(['expires_at'], 'idx_user_sessions_expires_at');
    table.index(['revoked_at'], 'idx_user_sessions_revoked_at');
  });

  await knex.schema.createTable('user_addresses', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.string('label', 50);
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
    table.boolean('is_default').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_user_addresses_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');

    table.index(['user_id'], 'idx_user_addresses_user_id');
    table.index(['city', 'district'], 'idx_user_addresses_city_district');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_user_addresses_default
    ON user_addresses (user_id)
    WHERE is_default = true;
  `);

  await knex.raw(`
    ALTER TABLE user_addresses
      ADD CONSTRAINT chk_user_addresses_latitude
      CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
      ADD CONSTRAINT chk_user_addresses_longitude
      CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
  `);

  await knex.schema.createTable('staff_profiles', (table) => {
    table.uuid('user_id').primary();
    table.string('employee_code', 50).unique();
    table.string('department', 100);
    table.string('status', 30).notNullable().defaultTo('active');
    table.uuid('created_by');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_staff_profiles_user')
      .references('id').inTable('users')
      .onDelete('CASCADE');
    table.foreign('created_by', 'fk_staff_profiles_created_by')
      .references('id').inTable('users')
      .onDelete('SET NULL');
  });

  // Seed canonical platform roles.
  await knex.raw(`
    INSERT INTO roles (id, code, name, description)
    VALUES
      (gen_random_uuid(), 'buyer', 'Buyer', 'Marketplace buyer role'),
      (gen_random_uuid(), 'seller', 'Seller', 'Marketplace seller role'),
      (gen_random_uuid(), 'admin', 'Admin', 'Marketplace operational administrator'),
      (gen_random_uuid(), 'super_admin', 'Super Admin', 'Platform-level administrator')
    ON CONFLICT (code) DO NOTHING;
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('staff_profiles');
  await knex.schema.dropTableIfExists('user_addresses');
  await knex.schema.dropTableIfExists('user_sessions');
  await knex.schema.dropTableIfExists('user_roles');
  await knex.schema.dropTableIfExists('roles');
  await knex.schema.dropTableIfExists('users');

  await knex.raw('DROP TYPE IF EXISTS user_status;');

  // Extensions are intentionally left installed because other schemas may use them.
}
/**
 * 002_seller_store.js
 * Wally Mall - Seller onboarding & Store domain
 * Category foreign keys are added in 003_catalog.js because categories belong to catalog.
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE store_status AS ENUM ('draft', 'pending', 'active', 'suspended', 'closed');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE verification_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE application_status AS ENUM ('draft', 'submitted', 'under_review', 'approved', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE document_status AS ENUM ('pending', 'verified', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('seller_applications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.string('proposed_store_name', 150).notNullable();
    table.text('business_description');
    table.uuid('business_category_id');
    table.specificType('status', 'application_status').notNullable().defaultTo('draft');
    table.timestamp('submitted_at', { useTz: true });
    table.uuid('reviewed_by');
    table.timestamp('reviewed_at', { useTz: true });
    table.text('rejection_reason');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_seller_applications_user')
      .references('id').inTable('users')
      .onDelete('RESTRICT');
    table.foreign('reviewed_by', 'fk_seller_applications_reviewed_by')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['user_id'], 'idx_seller_applications_user_id');
    table.index(['status'], 'idx_seller_applications_status');
    table.index(['created_at'], 'idx_seller_applications_created_at');
  });

  await knex.schema.createTable('seller_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('application_id').notNullable();
    table.string('document_type', 50).notNullable();
    table.text('file_url').notNullable();
    table.specificType('status', 'document_status').notNullable().defaultTo('pending');
    table.uuid('reviewed_by');
    table.timestamp('reviewed_at', { useTz: true });
    table.text('rejection_reason');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('application_id', 'fk_seller_documents_application')
      .references('id').inTable('seller_applications')
      .onDelete('CASCADE');
    table.foreign('reviewed_by', 'fk_seller_documents_reviewed_by')
      .references('id').inTable('users')
      .onDelete('SET NULL');

    table.index(['application_id'], 'idx_seller_documents_application_id');
    table.index(['status'], 'idx_seller_documents_status');
  });

  await knex.schema.createTable('stores', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('public_id', 30).notNullable().unique();
    table.specificType('slug', 'citext').notNullable().unique();
    table.string('name', 150).notNullable();
    table.text('description');
    table.text('logo_url');
    table.text('banner_url');
    table.uuid('primary_category_id');
    table.specificType('status', 'store_status').notNullable().defaultTo('draft');
    table.specificType('verification_status', 'verification_status').notNullable().defaultTo('unverified');
    table.decimal('rating_avg', 3, 2).notNullable().defaultTo(0);
    table.integer('rating_count').notNullable().defaultTo(0);
    table.boolean('is_founder').notNullable().defaultTo(false);
    table.timestamp('opened_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true });

    table.index(['status'], 'idx_stores_status');
    table.index(['primary_category_id'], 'idx_stores_primary_category_id');
    table.index(['created_at'], 'idx_stores_created_at');
  });

  await knex.raw(`
    ALTER TABLE stores
      ADD CONSTRAINT chk_stores_rating_avg CHECK (rating_avg BETWEEN 0 AND 5),
      ADD CONSTRAINT chk_stores_rating_count CHECK (rating_count >= 0);
  `);

  await knex.schema.createTable('store_members', (table) => {
    table.uuid('store_id').notNullable();
    table.uuid('user_id').notNullable();
    table.string('role', 30).notNullable();
    table.string('status', 30).notNullable().defaultTo('active');
    table.timestamp('joined_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['store_id', 'user_id'], 'pk_store_members');
    table.foreign('store_id', 'fk_store_members_store')
      .references('id').inTable('stores')
      .onDelete('CASCADE');
    table.foreign('user_id', 'fk_store_members_user')
      .references('id').inTable('users')
      .onDelete('RESTRICT');

    table.index(['user_id'], 'idx_store_members_user_id');
    table.index(['role'], 'idx_store_members_role');
  });

  await knex.raw(`
    ALTER TABLE store_members
      ADD CONSTRAINT chk_store_members_role
      CHECK (role IN ('owner', 'manager', 'staff')),
      ADD CONSTRAINT chk_store_members_status
      CHECK (status IN ('active', 'inactive'));
  `);

  await knex.schema.createTable('store_addresses', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable();
    table.string('type', 30).notNullable();
    table.string('province', 120).notNullable();
    table.string('city', 120).notNullable();
    table.string('district', 120);
    table.string('subdistrict', 120);
    table.string('postal_code', 10);
    table.text('address_line').notNullable();
    table.text('landmark');
    table.decimal('latitude', 10, 7);
    table.decimal('longitude', 10, 7);
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('store_id', 'fk_store_addresses_store')
      .references('id').inTable('stores')
      .onDelete('CASCADE');

    table.index(['store_id'], 'idx_store_addresses_store_id');
    table.index(['city', 'district'], 'idx_store_addresses_city_district');
  });

  await knex.raw(`
    ALTER TABLE store_addresses
      ADD CONSTRAINT chk_store_addresses_type
      CHECK (type IN ('storefront', 'warehouse', 'pickup')),
      ADD CONSTRAINT chk_store_addresses_latitude
      CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
      ADD CONSTRAINT chk_store_addresses_longitude
      CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

    CREATE UNIQUE INDEX uq_store_addresses_primary
      ON store_addresses (store_id)
      WHERE is_primary = true;
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('store_addresses');
  await knex.schema.dropTableIfExists('store_members');
  await knex.schema.dropTableIfExists('stores');
  await knex.schema.dropTableIfExists('seller_documents');
  await knex.schema.dropTableIfExists('seller_applications');

  await knex.raw('DROP TYPE IF EXISTS document_status;');
  await knex.raw('DROP TYPE IF EXISTS application_status;');
  await knex.raw('DROP TYPE IF EXISTS verification_status;');
  await knex.raw('DROP TYPE IF EXISTS store_status;');
}
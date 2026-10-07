/**
 * 003_catalog.js
 * Wally Mall - Catalog, discovery, tags, search analytics
 */

export async function up(knex) {
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE product_condition AS ENUM ('new', 'used');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE product_status AS ENUM ('draft', 'active', 'hidden', 'suspended', 'archived');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE moderation_status AS ENUM ('pending', 'approved', 'rejected');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      CREATE TYPE media_type AS ENUM ('image', 'video');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.schema.createTable('categories', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('parent_id');
    table.string('slug', 150).notNullable().unique();
    table.string('name', 150).notNullable();
    table.text('description');
    table.text('icon_url');
    table.integer('sort_order').notNullable().defaultTo(0);
    table.string('status', 30).notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true });

    table.foreign('parent_id', 'fk_categories_parent')
      .references('id').inTable('categories')
      .onDelete('SET NULL');

    table.index(['parent_id'], 'idx_categories_parent_id');
    table.index(['status'], 'idx_categories_status');
  });

  await knex.raw(`
    ALTER TABLE categories
      ADD CONSTRAINT chk_categories_status
      CHECK (status IN ('active', 'inactive'));

    ALTER TABLE seller_applications
      ADD CONSTRAINT fk_seller_applications_business_category
      FOREIGN KEY (business_category_id) REFERENCES categories(id)
      ON DELETE SET NULL;

    ALTER TABLE stores
      ADD CONSTRAINT fk_stores_primary_category
      FOREIGN KEY (primary_category_id) REFERENCES categories(id)
      ON DELETE SET NULL;
  `);

  await knex.schema.createTable('products', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('public_id', 30).notNullable().unique();
    table.uuid('store_id').notNullable();
    table.uuid('category_id').notNullable();
    table.specificType('slug', 'citext').notNullable().unique();
    table.string('name', 200).notNullable();
    table.text('description').notNullable();
    table.specificType('condition', 'product_condition').notNullable();
    table.specificType('status', 'product_status').notNullable().defaultTo('draft');
    table.specificType('moderation_status', 'moderation_status').notNullable().defaultTo('pending');
    table.bigInteger('min_price');
    table.bigInteger('max_price');
    table.decimal('rating_avg', 3, 2).notNullable().defaultTo(0);
    table.integer('rating_count').notNullable().defaultTo(0);
    table.integer('sold_count').notNullable().defaultTo(0);
    table.timestamp('published_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true });

    table.foreign('store_id', 'fk_products_store')
      .references('id').inTable('stores')
      .onDelete('RESTRICT');
    table.foreign('category_id', 'fk_products_category')
      .references('id').inTable('categories')
      .onDelete('RESTRICT');

    table.index(['store_id'], 'idx_products_store_id');
    table.index(['category_id'], 'idx_products_category_id');
    table.index(['status'], 'idx_products_status');
    table.index(['moderation_status'], 'idx_products_moderation_status');
    table.index(['name'], 'idx_products_name');
    table.index(['created_at'], 'idx_products_created_at');
  });

  await knex.raw(`
    ALTER TABLE products
      ADD CONSTRAINT chk_products_prices CHECK (
        (min_price IS NULL OR min_price >= 0)
        AND (max_price IS NULL OR max_price >= 0)
        AND (min_price IS NULL OR max_price IS NULL OR min_price <= max_price)
      ),
      ADD CONSTRAINT chk_products_rating_avg CHECK (rating_avg BETWEEN 0 AND 5),
      ADD CONSTRAINT chk_products_rating_count CHECK (rating_count >= 0),
      ADD CONSTRAINT chk_products_sold_count CHECK (sold_count >= 0);
  `);

  await knex.schema.createTable('product_variants', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('product_id').notNullable();
    table.string('sku', 100);
    table.string('name', 150).notNullable();
    table.bigInteger('price').notNullable();
    table.bigInteger('compare_at_price');
    table.bigInteger('cost_price');
    table.integer('weight_gram');
    table.string('status', 30).notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('product_id', 'fk_product_variants_product')
      .references('id').inTable('products')
      .onDelete('CASCADE');

    table.index(['product_id'], 'idx_product_variants_product_id');
    table.index(['sku'], 'idx_product_variants_sku');
    table.index(['status'], 'idx_product_variants_status');
  });

  await knex.raw(`
    ALTER TABLE product_variants
      ADD CONSTRAINT chk_product_variants_price CHECK (price >= 0),
      ADD CONSTRAINT chk_product_variants_compare_price CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
      ADD CONSTRAINT chk_product_variants_cost_price CHECK (cost_price IS NULL OR cost_price >= 0),
      ADD CONSTRAINT chk_product_variants_weight CHECK (weight_gram IS NULL OR weight_gram >= 0),
      ADD CONSTRAINT chk_product_variants_status CHECK (status IN ('active', 'inactive'));
  `);

  await knex.schema.createTable('product_media', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('product_id').notNullable();
    table.uuid('variant_id');
    table.specificType('media_type', 'media_type').notNullable().defaultTo('image');
    table.text('url').notNullable();
    table.text('thumbnail_url');
    table.string('alt_text', 255);
    table.integer('sort_order').notNullable().defaultTo(0);
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('product_id', 'fk_product_media_product')
      .references('id').inTable('products')
      .onDelete('CASCADE');
    table.foreign('variant_id', 'fk_product_media_variant')
      .references('id').inTable('product_variants')
      .onDelete('SET NULL');

    table.index(['product_id'], 'idx_product_media_product_id');
    table.index(['variant_id'], 'idx_product_media_variant_id');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_product_media_primary
      ON product_media (product_id)
      WHERE is_primary = true;
  `);

  await knex.schema.createTable('tags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 100).notNullable();
    table.string('normalized_name', 100).notNullable().unique();
    table.string('type', 30).notNullable().defaultTo('seller');
    table.string('status', 30).notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['normalized_name'], 'idx_tags_normalized_name');
  });

  await knex.raw(`
    ALTER TABLE tags
      ADD CONSTRAINT chk_tags_type CHECK (type IN ('seller', 'system', 'synonym')),
      ADD CONSTRAINT chk_tags_status CHECK (status IN ('active', 'inactive'));
  `);

  await knex.schema.createTable('product_tags', (table) => {
    table.uuid('product_id').notNullable();
    table.uuid('tag_id').notNullable();
    table.string('source', 30).notNullable();
    table.decimal('weight', 5, 2).notNullable().defaultTo(1);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['product_id', 'tag_id'], 'pk_product_tags');
    table.foreign('product_id', 'fk_product_tags_product')
      .references('id').inTable('products')
      .onDelete('CASCADE');
    table.foreign('tag_id', 'fk_product_tags_tag')
      .references('id').inTable('tags')
      .onDelete('CASCADE');

    table.index(['tag_id'], 'idx_product_tags_tag_id');
  });

  await knex.raw(`
    ALTER TABLE product_tags
      ADD CONSTRAINT chk_product_tags_source CHECK (source IN ('seller', 'system', 'admin')),
      ADD CONSTRAINT chk_product_tags_weight CHECK (weight > 0);
  `);

  await knex.schema.createTable('search_synonyms', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('term', 150).notNullable();
    table.string('synonym', 150).notNullable();
    table.decimal('weight', 5, 2).notNullable().defaultTo(1);
    table.string('status', 30).notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['term'], 'idx_search_synonyms_term');
    table.index(['synonym'], 'idx_search_synonyms_synonym');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX uq_search_synonyms_pair
      ON search_synonyms (lower(term), lower(synonym));

    ALTER TABLE search_synonyms
      ADD CONSTRAINT chk_search_synonyms_weight CHECK (weight > 0),
      ADD CONSTRAINT chk_search_synonyms_status CHECK (status IN ('active', 'inactive'));
  `);

  await knex.schema.createTable('search_queries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id');
    table.uuid('session_id');
    table.text('query').notNullable();
    table.text('normalized_query').notNullable();
    table.integer('results_count').notNullable().defaultTo(0);
    table.uuid('clicked_product_id');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_search_queries_user')
      .references('id').inTable('users')
      .onDelete('SET NULL');
    table.foreign('session_id', 'fk_search_queries_session')
      .references('id').inTable('user_sessions')
      .onDelete('SET NULL');
    table.foreign('clicked_product_id', 'fk_search_queries_clicked_product')
      .references('id').inTable('products')
      .onDelete('SET NULL');

    table.index(['user_id'], 'idx_search_queries_user_id');
    table.index(['created_at'], 'idx_search_queries_created_at');
  });

  await knex.raw(`
    ALTER TABLE search_queries
      ADD CONSTRAINT chk_search_queries_results_count CHECK (results_count >= 0);
  `);

  await knex.schema.createTable('product_views', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id');
    table.uuid('session_id');
    table.uuid('product_id').notNullable();
    table.string('source', 50);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_product_views_user')
      .references('id').inTable('users')
      .onDelete('SET NULL');
    table.foreign('session_id', 'fk_product_views_session')
      .references('id').inTable('user_sessions')
      .onDelete('SET NULL');
    table.foreign('product_id', 'fk_product_views_product')
      .references('id').inTable('products')
      .onDelete('CASCADE');

    table.index(['product_id'], 'idx_product_views_product_id');
    table.index(['user_id'], 'idx_product_views_user_id');
    table.index(['created_at'], 'idx_product_views_created_at');
  });

  await knex.schema.createTable('analytics_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id');
    table.uuid('session_id');
    table.string('event_name', 100).notNullable();
    table.string('entity_type', 50);
    table.uuid('entity_id');
    table.jsonb('metadata');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.foreign('user_id', 'fk_analytics_events_user')
      .references('id').inTable('users')
      .onDelete('SET NULL');
    table.foreign('session_id', 'fk_analytics_events_session')
      .references('id').inTable('user_sessions')
      .onDelete('SET NULL');

    table.index(['event_name'], 'idx_analytics_events_event_name');
    table.index(['user_id'], 'idx_analytics_events_user_id');
    table.index(['created_at'], 'idx_analytics_events_created_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('analytics_events');
  await knex.schema.dropTableIfExists('product_views');
  await knex.schema.dropTableIfExists('search_queries');
  await knex.schema.dropTableIfExists('search_synonyms');
  await knex.schema.dropTableIfExists('product_tags');
  await knex.schema.dropTableIfExists('tags');
  await knex.schema.dropTableIfExists('product_media');
  await knex.schema.dropTableIfExists('product_variants');
  await knex.schema.dropTableIfExists('products');

  await knex.raw(`
    ALTER TABLE stores DROP CONSTRAINT IF EXISTS fk_stores_primary_category;
    ALTER TABLE seller_applications DROP CONSTRAINT IF EXISTS fk_seller_applications_business_category;
  `);

  await knex.schema.dropTableIfExists('categories');

  await knex.raw('DROP TYPE IF EXISTS media_type;');
  await knex.raw('DROP TYPE IF EXISTS moderation_status;');
  await knex.raw('DROP TYPE IF EXISTS product_status;');
  await knex.raw('DROP TYPE IF EXISTS product_condition;');
}
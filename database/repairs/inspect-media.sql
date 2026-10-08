-- Read-only: run before repair and again after migration 012.
SELECT current_database(), current_schema();
SELECT to_regclass('public.product_media') AS product_media,
       to_regclass('public.media_assets') AS media_assets,
       to_regclass('public.products') AS products,
       to_regclass('public.product_variants') AS product_variants,
       to_regtype('public.media_type') AS media_type;

SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('product_media', 'media_assets')
ORDER BY table_name, ordinal_position;

SELECT id, name, batch, migration_time FROM public.knex_migrations ORDER BY id;

SELECT c.relname AS table_name, con.conname, con.convalidated,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('product_media', 'media_assets')
ORDER BY c.relname, con.conname;

SELECT tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname = 'public'
AND tablename IN ('product_media', 'media_assets')
ORDER BY tablename, indexname;

SELECT e.enumlabel FROM pg_enum e
WHERE e.enumtypid = to_regtype('public.media_type') ORDER BY e.enumsortorder;

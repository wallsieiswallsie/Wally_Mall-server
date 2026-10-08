-- One-time incident repair, NOT a Knex migration.
-- First inspect with inspect-media.sql. Pause concurrent deployments/migrations.
-- Reconstructs only the empty baseline from 20260924060803_003_catalog.js.
-- Does not recover deleted rows. Intentionally refuses existing/partial tables.
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.knex_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF to_regclass('public.product_media') IS NOT NULL
     OR to_regclass('public.media_assets') IS NOT NULL THEN
    RAISE EXCEPTION 'Expected both media tables absent; inspect before repair';
  END IF;
  IF to_regclass('public.products') IS NULL
     OR to_regclass('public.product_variants') IS NULL
     OR to_regtype('public.media_type') IS NULL THEN
    RAISE EXCEPTION 'Missing canonical catalog prerequisites';
  END IF;
  IF (SELECT array_agg(enumlabel::text ORDER BY enumsortorder)
      FROM pg_enum WHERE enumtypid = to_regtype('public.media_type'))
      IS DISTINCT FROM ARRAY['image', 'video']::text[] THEN
    RAISE EXCEPTION 'Unexpected media_type definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.knex_migrations
      WHERE name = '20260924060803_003_catalog.js')
     OR (SELECT count(*) FROM public.knex_migrations) <> 11
     OR EXISTS (SELECT 1 FROM public.knex_migrations WHERE name LIKE '%012%') THEN
    RAISE EXCEPTION 'Expected completed 001-011 only; inspect migration history';
  END IF;
END $$;

CREATE TABLE public.product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  variant_id uuid,
  media_type public.media_type NOT NULL DEFAULT 'image',
  url text NOT NULL,
  thumbnail_url text,
  alt_text varchar(255),
  sort_order integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_media_product FOREIGN KEY (product_id)
    REFERENCES public.products(id) ON DELETE CASCADE,
  CONSTRAINT fk_product_media_variant FOREIGN KEY (variant_id)
    REFERENCES public.product_variants(id) ON DELETE SET NULL
);
CREATE INDEX idx_product_media_product_id ON public.product_media(product_id);
CREATE INDEX idx_product_media_variant_id ON public.product_media(variant_id);
CREATE UNIQUE INDEX uq_product_media_primary ON public.product_media(product_id)
  WHERE is_primary = true;
COMMIT;

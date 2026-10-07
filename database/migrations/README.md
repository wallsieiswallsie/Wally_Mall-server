# Wally Mall Database Migrations

PostgreSQL + Knex migrations in ESM format.

## Order

1. `001_identity.js`
2. `002_seller_store.js`
3. `003_catalog.js`
4. `004_inventory.js`
5. `005_cart.js`
6. `006_commerce.js`
7. `007_payment.js`
8. `008_fulfillment.js`
9. `009_trust_moderation.js`
10. `010_finance.js`
11. `011_category_name_unique.js` — case-insensitive unique category names (non-deleted rows); aborts if existing names collide

12. `012_media_assets.js` — managed GCS upload metadata and optional product media asset relation; preserves legacy URLs.

The sequence is dependency-aware. Run migrations in ascending order and roll them back in descending order.

## Coverage

The 10 modules cover all 50 tables and all 19 PostgreSQL enum types from the supplied `Wally_Mall.sql` schema.

## Requirements

- PostgreSQL
- Knex
- `pg` driver
- ESM project (`"type": "module"`) or equivalent Knex ESM support

The first migration enables `pgcrypto` and `citext`. UUID primary keys default to `gen_random_uuid()`.

## Notes

In addition to the base schema, the migrations add production integrity constraints such as non-negative money/stock values, one active cart per user, one default user/store address, idempotent payment provider events, rating bounds, and append-only audit logs.

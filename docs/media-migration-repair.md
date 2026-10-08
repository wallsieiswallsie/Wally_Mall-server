# Media migration consistency audit — 2026-10-08

## Cause and observed state

The incident reset deleted `product_media`, which belongs to completed migration
`20260924060803_003_catalog.js`. Removing the previous 012 history entry and
renaming 012 cannot recreate a table owned by 003. Knex tracks filenames, not
schema equivalence. The replacement 012 fails with PostgreSQL `42P01` when it
alters the missing table.

Read-only inspection of the configured Railway database confirmed 001–011
completed, only `20261007121411_012_media_assets.js` pending, both media tables
absent, and `products`, `product_variants`, and `media_type ('image','video')`
present. Git commit 56c6ce5 renamed 012 with no SQL changes. Historical reports
cover earlier migration counts; they do not prove this filename ran elsewhere.
Other deployments cannot be inferred from Git or this database's history.

003 is canonical. 004–011 contain no reference to `product_media`. Catalog
reads `url` and `thumbnail_url`; checkout reads the primary image's `url`;
the media service inserts permanent `public_url` into `url` and uses
`media_asset_id` for attachment, ownership/lifecycle and cleanup.

## Repair decision

Keep **all migrations, including 003 and 012, unchanged**. A separate one-time
SQL repair restores precisely the empty 003 baseline. This avoids making every
future install silently repair accidental deletion and keeps catalog ownership
in 003 and managed asset integration in 012. No other 003 objects are recreated.
No migration records are manually inserted, deleted, or modified.

The exact executable SQL is checked in:

1. [Read-only inspection](../database/repairs/inspect-media.sql): run first in
   pgAdmin against the intended database. Confirm the state above, including all
   eleven migration filenames. Inspect constraints and indexes, not just history.
2. [Guarded baseline restoration](../database/repairs/restore-product-media.sql):
   run once only for this confirmed incident state, with deployments/migrations
   paused. It refuses existing media tables or missing prerequisites. It creates
   the exact original columns/defaults, two foreign keys, two normal indexes and
   partial primary-image unique index. It does **not** add `media_asset_id`.
   If it fails in pgAdmin, issue `ROLLBACK` before further work and inspect the
   error; do not bypass its guards. Deleted rows are not recovered by this repair.
3. From `server/`, run `npm run db:status`, `npm run db:latest`, then
   `npm run db:status`. Expect only 012 applied and `pending: []` afterward.
4. Run the read-only inspection again. Verify the complete definitions, including
   `fk_product_media_product` (CASCADE), `fk_product_media_variant` (SET NULL),
   `fk_product_media_asset` (RESTRICT), `uq_product_media_asset`, and
   `chk_product_media_managed_url`; verify `idx_product_media_product_id`,
   `idx_product_media_variant_id`, and partial `uq_product_media_primary`.
   Verify `media_asset_id` is nullable UUID and both tables exist.
   Compare 001–011 history rows with the pre-repair results: unchanged.

The installed Knex Migrator defaults to transactions; neither knexfile nor 012
disables them. All 012 statements, including ordinary raw DDL, run on the supplied
transaction. No concurrent-index statement or external connection escapes it.
A failure rolls back `media_assets`, constraints, column changes and the history
insert. The repair SQL independently uses BEGIN/COMMIT. Its guard failure leaves
no partial baseline. 012's unconditional up and corresponding down remain paired.

012 retains all existing asset fields: id, owner_id, source, purpose, bucket,
object_key, public_url, original_filename, content_type, size_bytes, status,
generation, expires_at, created_at, updated_at, purged_at. Both URL checks remain
unchanged. Stored managed URLs remain permanent GCS URLs, never signed GET URLs.
The nullable relation continues to allow legacy media URLs.

## Commands and deployment

`migrate`, `migrate:status`, and `migrate:rollback` now delegate to their `db:*`
equivalents. Both naming families load optional `.env` via Node before importing
the same `connect()`/knexfile configuration. Injected process environment values
take precedence; Railway requires no physical `.env`. CLI/knexfile are unchanged.
Rollback commands still roll back a batch: do not use them as incident repair.

Keep Railway's lifecycle: build → `npm run migrate` pre-deploy → `npm start`.
Set the service's **Pre-deploy Timeout to 60 seconds** initially, increasing it
if measured migration duration/lock waits warrant it. This is separate from the
HTTP health-check timeout and Knex's 5-second connection acquisition timeout.
No Railway configuration file exists here; apply the timeout in service settings.
See [Railway pre-deploy documentation](https://docs.railway.com/deployments/pre-deploy-command).

## Regression prevention

- Treat applied migrations (including filenames) as immutable in every environment.
  Never edit or rename an applied production migration; use a new migration.
- Never drop baseline objects from completed migrations without a recovery plan.
  Status alone cannot detect schema drift. Preserve backups if rows matter.
- The integration suite already tests clean latest → full rollback → latest.
  It now also tests 011 → 012, targeted 012 down/up, missing-table failure
  atomicity, exact repair equivalence to 003, history preservation and expected
  integration constraints/indexes. Existing media tests reject expiring URLs.
- Use a dedicated disposable PostgreSQL database for `TEST_DATABASE_URL` and
  run `npm test` with that variable injected. Without it, database and startup
  tests skip. The integration suite resets its public schema: never target an
  application database. No extra infrastructure or dependencies were introduced.
- When CI is available, provision a clean PostgreSQL service and run this suite;
  it executes the same Knex `migrate.latest()` implementation as the CLI, plus
  upgrade and rollback checks. Do not reset a shared CI/application database.

## Verification results

- Configured Railway database: guarded repair executed successfully. Original
  001–011 history rows (IDs, filenames, batches, timestamps) compared exactly
  equal before and after. No unrelated table or row was deleted.
- `npm run db:status` before: 11 completed, only 012 pending.
- `npm run db:latest`: applied 012 in batch 3.
- `npm run db:status` after: 12 completed, `pending: []`.
- Post-migration SQL: both tables present, expected columns/defaults confirmed,
  nullable UUID `media_asset_id`, all requested FK/check/unique constraints
  validated, and all requested indexes present with correct definitions.
- `npm run migrate`: `[3, []]`, successful no-op using the unified CLI.
- `npm test` with TEST_DATABASE_URL injected for newly created local
  `wally_media_repair_test_20261008`: **32 passed, 0 failed, 0 skipped**.
  Includes fresh migration/rollback, the incident recovery regression, permanent
  URL checks, API integration, and actual HTTP startup/health/readiness.
  The intentional 42P01 log in the regression is expected and asserted.
- `npm run migrate:status`: successful, 12 completed and `pending: []`.
- `git diff --check` passed. All migration JavaScript files remain unchanged;
  only the migrations README gained incident/prevention guidance.
- Initial sandbox database access failed (DNS/network restriction); elevated
  network access succeeded. This was not a database configuration repair.
  Initial local cluster role guesses failed; the documented test-only role was
  then used to create a new isolated database successfully.
- No manual pgAdmin repair is required for this configured database now. The
  repair SQL is retained for review and will deliberately refuse to run again.
- Railway settings/deployment were not changed or independently smoke-tested.
  Deploy the script changes and set the timeout to 60 seconds. Other database
  environments require their own read-only inspection; do not remove old 012
  history if an environment still records the previous filename.
- Remaining limitations: this restores schema, not previously deleted images or
  rows. Tests use local PostgreSQL 17; the configured database's catalog includes
  additional PostgreSQL-generated NOT NULL constraint entries. Expected live
  schema definitions were inspected separately. A pre-existing Fastify
  deprecation warning is non-failing and outside this repair.

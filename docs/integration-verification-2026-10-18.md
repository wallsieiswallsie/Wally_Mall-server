# Local integration verification — 2026-10-18

## Scope and source state

Both repositories remain separate on `codex/integration-recovery`. Server base: `dcfd571`; client base: `23c6780`. Both origin/main refs were fetched and had no newer commits than these local bases. Existing uncommitted server configuration changes and the client portal refactor were retained. No commit, push, merge, deployment, scheduler activation or production database change was performed.

Server additions: authenticated seller product detail, buyer payment recovery projection, explicit mock provider validation, schema-aware read-only readiness, restricted-store metadata mutation check, opt-in proxy trust, worker service manifests, independent tests and explicit cross-repository contract CI.

Client additions: seller-owned detail loading, order navigation from server payment IDs, payment state actions, removal of obsolete payment mapping cache, browser/unit regressions, current separate-repository deployment documentation and CI.

## Findings and evidence

| Finding / cause | Fix | Verification |
| --- | --- | --- |
| Seller editor queried public catalog, excluding zero-stock/hidden/draft/pending products | GET seller/products/:id with membership; editor uses authenticated endpoint | Native API tests: zero-stock restock; hidden/draft pending records; outsider read/write rejected; buyer rejected; staff read only; manager write; restricted store/product rejected |
| Order projection omitted payment identity; UI required sessionStorage mapping | Buyer orders and checkout include owned minimal payment; UI reads server data | Native contract: fresh client instance restores auth and recovers same payment from orders; repeated session keeps same reference and one payment row. Edge fixture: missing mapping, resume action, terminal states, no checkout creation |
| PAYMENT_PROVIDER did not select adapter | Explicit mock-only factory and config/app validation; payment session verifies persisted provider | Unsupported providers and adapter mismatch rejected; existing signature, amount, idempotency/refund and late reconciliation tests retained |
| Expiry and cleanup commands did not establish scheduled execution | Three separate Railway manifests and operational instructions | Concurrent expiry and repeated expiry release reservations once without reducing on_hand; one-shot expiry exits successfully. Cleanup fixture tests retain attached media, purge eligible orphan and retry idempotently. Scheduler remains inactive |
| /ready accepted SELECT 1 with absent schema | Compare migration names read-only; resolve critical tables/columns with LIMIT 0; return generic 503 | Empty database readiness makes no history table; migration pending and missing media_asset_id fail despite working DB; restored schema returns 200; HTTP startup tested |
| Server suite imported sibling client at module load | Server-only suite; explicit CLIENT_API_MODULE contract runner | Clean isolated server source copy, no sibling client: npm ci succeeds and all 36 tests pass |
| Proxy headers could not distinguish clients behind ingress | Explicit trusted peer IP/CIDR option; default remains false | Spoofed forwarding ignored for untrusted peer; accepted only for configured peer. Deployment ingress CIDRs not assumed |
| Documentation referenced parent workspace files and prototype-only capabilities | Local deployment guides and repository URLs | References changed for touched integration docs; prototype and real API/DB test evidence distinguished |

## Contract changes

All business API paths below use `/api/v1`.

- New `GET /seller/products/:id`: product identity/status/moderation/price range plus variants with physical, reserved and available inventory.
- Buyer `GET /orders`, `/orders/:id`, `/checkouts/:id`: additive `payment` object with `id`, `status`, `method`, `expires_at`. Existing seller/admin payment projections unchanged.
- `POST /payments/:id/session`: explicit `PAYMENT_PROVIDER_MISMATCH` or `PAYMENT_EXPIRED` rejection when applicable; ownership remains enforced.
- `/ready`: unavailable DB, pending/unknown migration history or missing critical schema returns HTTP 503 `{status:"not_ready"}`. `/health` remains process liveness.

## Migration inventory and compatibility

12 existing migrations: 001 identity, 002 seller_store, 003 catalog, 004 inventory, 005 cart, 006 commerce, 007 payment, 008 fulfillment, 009 trust_moderation, 010 finance, 011 category_name_unique, 012 media_assets. No new migration; no existing migration changed.

Native PostgreSQL 17 tests applied all migrations to empty databases, rolled back/reapplied the full batch, and exercised 012 upgrade/down/reapply, media columns, FKs, check/unique constraints and indexes. Existing history was never reset. The historical missing-product_media test deliberately reproduces the fault and validates its existing explicit repair script **only in disposable test DB**; production startup/readiness never repairs schema. No impact on existing production data was introduced by a migration.

## Commands and results

Commands were run with the required `rtk` prefix; PowerShell environment setup supplied only local test values. PostgreSQL listened on 127.0.0.1:55439 in a newly initialized cluster.

| Command / context | Result |
| --- | --- |
| `git fetch origin`, each repo | Success; no new main commits |
| `npm ci --no-audit --no-fund`, server/client | Success: 161 / 88 packages |
| `initdb -D .test-postgres-native -U postgres -A trust --encoding=UTF8 --no-locale`; `pg_ctl ... -o "-h 127.0.0.1 -p 55439" -w start` | Disposable PostgreSQL 17 cluster created/started |
| `createdb` wally_test_integration, wally_contract_test, wally_standalone_test | Three separate empty local test databases |
| `npm test`, server with TEST_DATABASE_URL | 36 passed, 0 failed, 0 skipped |
| `npm ci`; `npm test`, `.verification/standalone-server` with separate TEST_DATABASE_URL | 36 passed, 0 failed, 0 skipped; no client sibling |
| `npm run test:contract`, explicit absolute CLIENT_API_MODULE + fresh TEST_DATABASE_URL | 20 passed, 0 failed, 0 skipped; real client API, Fastify injection and native DB |
| `npm test`, client | 25 passed, 0 failed, 0 skipped; unit/domain and fixture tests |
| `npm run build:all`, VITE_API_URL=https://api.example.test, VITE_PROTOTYPE_MODE=false | Compatibility, buyer, seller, admin production builds passed |
| `npm run test:structure` | 88 modules checked; no import/boundary/cycle issues |
| `npm run test:render` | 34 compatibility checks and 33 identical portal renders passed; prototype fixtures |
| `node tests/recovery-browser.mjs`, bundled Playwright module, PLAYWRIGHT_CHANNEL=msedge | Passed live UI fixture regression for storage-free recovery and terminal payment states |
| `npm run payments:expire`, disposable DATABASE_URL | Exit 0, `{ expired: 0 }` after integration cleanup |
| `npm run migrate:status`, disposable DATABASE_URL | 12 completed, no pending migrations |
| `git diff --check`, each repo | Passed |

Initial sandbox fetch/install attempts were blocked or stalled; permitted retries succeeded. An early test run started while installation was incomplete and failed on missing packages; it is not counted as passing evidence. Default Playwright Chromium was absent; the browser check passed using installed Edge. Fastify emits an existing disableRequestLogging deprecation warning. The expected 012 failure printed by the negative migration test is asserted and does not represent a failed suite.

## Remaining deployment work and limits

See [concrete service/environment instructions](integration-recovery.md). Select HTTP/expiry/cleanup config files, apply migration pre-deploy, verify ingress trust, configure build-time client origins and backend/GCS CORS, then explicitly activate and inspect worker runs. These actions were not executed. Railway settings/private logs, GCS IAM/signing/public object access and production data were not accessed or verified. GCS tests use a storage fixture. The cross-repository suite uses injected HTTP transport; browser tests use fixtures. No claim of a browser-to-production end-to-end pass is made.

CI is prepared but not run on GitHub; cross-repo checkout needs the matching client ref and appropriate read access if private. Per-replica rate limiting remains local; no distributed limiter or real gateway was introduced. Courier workflow, payouts, review submission, promotions and semantic search remain out of scope.

Suggested separate commits:

- Server: `fix: restore seller inventory and buyer payment recovery with deployment checks`
- Client: `fix: load seller variants and resume payments from server contracts`

The working trees include pre-existing changes; select review/commit hunks accordingly.

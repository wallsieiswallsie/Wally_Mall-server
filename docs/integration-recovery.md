# Integration recovery and deployment

The server and [client](https://github.com/wallsieiswallsie/Wally_Mall-client) are separate repositories. Commands here run at the server repository root. Never use production DATABASE_URL for tests.

## Contracts

- `GET /api/v1/seller/products/:id`: seller role plus active store membership (owner, manager, staff). Returns product ID, store, name, status, moderation status, price range and variants (`id`, `name`, `price`, `status`, `on_hand`, `reserved`, `available`). Catalog filtering is unchanged. Mutations still require owner/manager and reject restricted stores/products and physical stock below reservations.
- Buyer `GET /api/v1/orders`, `/orders/:id`, `/checkouts/:id`: `payment: {id,status,method,expires_at}`. Buyer ownership is enforced before projecting payment data. Seller order responses retain their previous restricted payment projection.
- `POST /api/v1/payments/:id/session`: retains ownership checks, rejects expired pending intents and provider mismatches, and reuses the same payment ID as provider idempotency key. Only mock is implemented. Unsupported PAYMENT_PROVIDER fails startup.
- `/health`: process liveness. `/ready`: 200 only when migration history is current and critical tables/columns resolve; otherwise 503 `{status:"not_ready"}` without database internals. Probes perform metadata/zero-row queries, never migration or repair.

No migration was added or changed. There are currently 12 migrations; the integration suite derives the count from the directory. Migration 003 owns product_media; 012 adds media_assets and nullable product_media.media_asset_id, retaining legacy media URLs. Pre-deploy uses `npm run migrate` against the same DATABASE_URL as runtime. Never roll back or reset migration history during startup.

## Railway services (activation pending)

Create three services from **Wally_Mall-server**, each with root directory `/` (package.json directory). Install with `npm ci`. Select the corresponding custom config file in each service's settings:

| Service | Config path | Command | Schedule |
| --- | --- | --- | --- |
| HTTP | `/railway.http.json` | `npm start`; pre-deploy `npm run migrate` | Persistent; health `/ready` |
| Payment expiry | `/railway.expiry.json` | `npm run payments:expire` | Every 5 minutes, UTC |
| Media cleanup | `/railway.cleanup.json` | `npm run media:cleanup` | Hourly at minute 17, UTC |

Workers exit and close database pools after each run. Do not give workers HTTP health checks, public domains, or restart-always policies. Deploy migrations through HTTP pre-deploy before enabling workers. Cleanup processes up to 100 eligible assets per run; monitor backlog and adjust frequency if required. Expiry and cleanup can safely retry; cleanup rechecks media references under lock. A scheduler is **not active** merely because these files exist. Check actual run history, exit status and backlog after activation.

All services currently use configFromEnv: provide NODE_ENV=production, DATABASE_URL (same private database reference), ACCESS_TOKEN_SECRET and PAYMENT_WEBHOOK_SECRET (independent values of at least 32 characters), PAYMENT_PROVIDER=mock, exact CORS_ORIGINS, and GCS_BUCKET. Preserve existing fee variables BUYER_SERVICE_FEE, SELLER_DELIVERY_FEE, WALLY_LOCAL_FEE. HTTP uses HOST=0.0.0.0 and Railway's PORT. Media cleanup additionally requires GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_JSON or supported application default credentials with bucket deletion access. HTTP media uploads require signing, object verification and read access as configured in src/gcs.js. Do not put any credentials in VITE_* variables.

For GCS, run `npm run media:cors` only after configuring approved client origins and explicitly scheduling that external change. Verify signed PUT, completion, public GET and cleanup against a dedicated test bucket. Local tests use a storage adapter fixture, not Google Cloud. Bucket CORS, IAM, service-account signing and public URL reachability have not been verified against deployment in this task.

## Network boundaries

Client VITE_API_URL is an HTTP(S) **origin**, without /api/v1; the shared API module appends that prefix. It is required at production build. API_PROXY_TARGET is the development/preview backend origin. CORS_ORIGINS contains exact buyer/seller/admin origins, no wildcard, path or trailing slash.

TRUSTED_PROXY_CIDRS defaults to empty (forwarded headers ignored). Set only explicit peer IPs/CIDRs after verifying the actual Railway ingress path and its forwarded-header sanitization. Never set true, wildcard or /0. Do not assume all private networks or a fixed hop count are trusted. Without verified ingress, rate limits group requests by proxy peer; this operational limitation remains pending. Rate limits are per process, so multi-replica distributed limits remain backlog. Tests cover spoofed forwarded headers from untrusted peers.

## Verification levels

- `npm ci && npm test`: server-only suite; native integration/startup are skipped unless TEST_DATABASE_URL is provided. No sibling checkout is imported.
- TEST_DATABASE_URL must name a fresh disposable database containing `test` and differ from DATABASE_URL. The suite refuses existing migration history; it never resets a database. It exercises empty migration, full rollback/reapply, 012 upgrade/rollback, schema constraints, API authorization, concurrency, expiry and media reference safety. A historical media incident test performs explicit repair only inside this disposable database.
- `npm run test:contract`: requires a separate **fresh** TEST_DATABASE_URL and CLIENT_API_MODULE pointing to the absolute client `packages/api-client/client.js`. Runs the real client API implementation against Fastify and native PostgreSQL, including payment recovery without browser mapping. Transport is Fastify injection, not a browser or external network.
- Client unit/domain fixtures and prototype render smoke are distinct from live API/DB integration. Neither verifies external GCS or Railway.

Backlog: real payment gateways, courier role workflow, seller payout, review submission, promotions and semantic search. No claim is made that prototype features exist in live mode.

CI workflows are prepared but have not run on GitHub. The contract job explicitly checks out both repositories and requires the client workspace changes to be available at the selected client ref. For private repositories, provide a narrowly scoped repository-read token to that checkout; the default token cannot read another private repository. Pin a compatible client commit when enabling the workflow.

References: [Railway config](https://docs.railway.com/config-as-code/reference), [pre-deploy](https://docs.railway.com/deployments/pre-deploy-command), [cron run history](https://docs.railway.com/cli/cron).

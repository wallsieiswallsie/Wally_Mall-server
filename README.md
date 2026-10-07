# Wally Mall server

Backend Node.js 22 / Fastify / Knex / PostgreSQL. `client/` now uses these APIs by default; the old prototype is an explicit opt-in mode. See [combined setup](../README.md) and [integration audit and remaining gaps](../docs/client-server-integration.md).

**`database/` is the authoritative database module.** Its original `migrations/001_identity.js` through `010_finance.js` define the frozen 50-table, 19-enum contract. They have not been rewritten. The original migration README references `Wally_Mall.sql`, but that SQL/ERD artifact is absent from this checkout. No replacement ERD has been generated.

Database paths describe responsibilities rather than the application name:

```text
server/database/
  index.js       # Shared connection and readiness checks
  knexfile.js    # Single Knex configuration
  cli.js         # Migration and seed commands
  migrations/    # Versioned schema changes
  repositories/  # Data access
  transactions/  # Atomic business workflows
  seeds/         # Development fixtures
```

HTTP modules, the expiry worker, tests and package scripts reference this same root. Migration and seed directories resolve relative to `knexfile.js`, independently of the process working directory. The folder rename does not change migration filenames, schema definitions, or Knex's migration-history table; existing databases do not need rollback or reinitialization.

## Install and run

Run from the repository root on Windows (use `npm` instead of `npm.cmd` on other platforms):

```powershell
npm.cmd --prefix server ci
Copy-Item server/.env.example server/.env
# Edit server/.env: database URL, random secrets, CORS, and server-owned fees.
npm.cmd --prefix server run db:latest
npm.cmd --prefix server run db:status
npm.cmd --prefix server start
```

`GET http://127.0.0.1:3001/health` checks the process. `/ready` checks PostgreSQL connectivity. Mock payments remain available for deployed testing with `NODE_ENV=production`; no real payment is processed. See the [Railway connectivity audit and deployment runbook](docs/railway-connectivity.md) for binding, build-time client variables, migrations and verification.

Never commit `.env`. Generate each token/signature secret using a cryptographically secure random generator. Set `CORS_ORIGINS` to exact trusted origins; wildcard origins are unsupported. Authorization uses explicit Bearer headers, not automatically attached cookies. Browser integration must keep refresh credentials out of localStorage; a secure BFF/cookie transport would also require CSRF controls. No browser role picker is trusted.

## Migration, rollback, seed

```powershell
npm.cmd --prefix server run db:latest
npm.cmd --prefix server run db:status
npm.cmd --prefix server run db:rollback
npm.cmd --prefix server run db:seed
```

All commands call the same module CLI and the sole Knex configuration at `database/knexfile.js`. Migration/seed paths are absolute and resolved from that file; there is no second database root. Rollback reverts the last batch and is destructive to data in those tables. It is an explicit operator command, never a startup action.

The development seed requires explicit `SEED_SUPER_ADMIN_EMAIL` and `SEED_SUPER_ADMIN_PASSWORD` (12+ characters), refuses production and refuses to overwrite an existing account. It creates the privileged account through `roles`/`user_roles`, a staff profile, audit entry, and one development category. No built-in password or real credential is supplied. Integration tests create their own marketplace fixtures.

## Architecture

`src/` contains HTTP routing, strict payload/query schemas, password/token security, response/domain projections, configuration and the payment adapter boundary. `database/repositories/` and `transactions/` contain every query, connection, lock, persistence operation and transactional workflow. Routes never issue table queries. `src/app.js` supports Fastify injection for API integration tests; `src/index.js` is the listening process.

Responses use `{data: ...}`; errors use `{error: {code, request_id}}`. Money is an integer IDR **decimal string** at the JSON boundary; calculations use BigInt and enforce PostgreSQL bigint bounds. Page filters use bounded `limit`/`offset`, and the initial private lists cap at 100 records. See [API mapping](docs/client-api-mapping.md) for endpoints and adapter changes required in the client.

## Authentication and authorization

Passwords use salted scrypt (N=131072, r=8, p=1). Random refresh credentials are SHA-256 hashed in `user_sessions.refresh_token_hash`, rotated under a row lock, and valid for 30 days. Signed 15-minute access credentials identify a session, never a role. Every authenticated request reloads session validity, active user status and unrevoked `user_roles → roles`. Logout revokes the session, immediately invalidating its access token. Public registration always creates a buyer. Seller approval grants seller capability; it does not remove buyer capability.

Buyer resources use the authenticated ID. Seller mutations use active `store_members` with owner/manager capability; fulfillment also permits active staff. Sellers cannot restore a suspended store or approve their listings. Admin operates masked order views and moderation. Only Super Admin can access finance, buyer administration, staff provisioning, fee changes, refunds or full audit entries. Admin provisioning always grants exactly `admin`; reset revokes sessions, without inventing a recovery link or sending an invitation.

## Commerce and payments

Cart items reference variants. Cart mutations reload variant/product/store/inventory state. Quote and checkout recompute prices and fees from database records. Checkout locks the buyer/cart and default inventory rows in stable variant order, groups by store, and atomically persists checkout, orders, item/address/fee snapshots, histories, reservations, fulfillments and a pending payment intent. Any failure rolls back all these writes. Converted carts cannot produce a second checkout on retry; clients recover through their orders rather than blindly submitting a new cart.

Available stock is `on_hand - reserved`. The initial service uses only inventory with `store_address_id IS NULL`; it never combines location rows it cannot subsequently trace. Reservation, release and sale all append inventory movements. On payment success, on-hand and reserved both decrease; failed/expired payments release reserved only. Success after expiry is retained as an unprocessed event requiring explicit provider reconciliation, never silently treated as a valid sale.

`POST /payments/:id/session` calls the adapter with the persisted payment ID as its idempotency key. The development adapter creates non-payable references. A real implementation must support provider-side idempotency, remote status reconciliation and provider fee allocation. Browser callbacks cannot change payment state. The development webhook verifies an HMAC SHA-256 of the exact JSON bytes using `x-payment-signature`, checks amount/currency, and uses unique `(provider, provider_event_id)` plus payment row locking for replay protection. Do not expose the signing secret to browser code.

Run the expiration command periodically in the deployment scheduler:

```powershell
npm.cmd --prefix server run payments:expire
```

This command is safe to repeat and releases unpaid reservations without browser activity. There is no scheduler installed by this task. A production operator must also reconcile late provider settlements and interrupted provider calls.

Refunds are full order refunds, restricted to Super Admin, persisted before calling the provider, and retryable by refund ID. A provider timeout leaves `processing`; replay resumes the same refund. Refund success updates payment to partially/fully refunded. Physical stock is not automatically returned because a financial refund does not prove returned goods. Status projection uses the order's refund, so one refunded seller order does not label all sibling orders refunded.

Fee precedence is store, category, then global; newest effective rule wins with an ID tie-break. Percentage + fixed fee applies once per matched rule group and is capped at group goods value. Existing fee snapshots never change. Buyer service/delivery prices come from explicit server configuration; gateway fee and discount are zero until backed by a real provider/promotion policy. Seller ledger and payouts remain unexposed future scope, not simulated settlements.

## Verification

```powershell
npm.cmd --prefix server test
# Put TEST_DATABASE_URL in server/.env for a disposable database whose name contains "test".
# It must differ from DATABASE_URL. This test drops and recreates that database's public schema.
npm.cmd --prefix server run test:integration
```

Without `TEST_DATABASE_URL`, integration tests explicitly skip; unit tests still run. Use the separate integration command when `.env` supplies the test URL. Tests exercise real original migrations, rollback, authorization, stock concurrency, late-failure rollback, snapshots, payment replay, refund retry, moderation and audit immutability. [Verification report](docs/verification.md) records the checks actually executed in this task.

Read [database contract](docs/database-contract.md), [status mapping](docs/status-mapping.md), and [database gaps](docs/database-gap-report.md) before extending persistence.

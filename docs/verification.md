# Verification — 24 September 2026

Executed on Windows, Node.js 22.14.0 and a dedicated PostgreSQL 17 cluster at `127.0.0.1:55439`, database `wally_test`, role `wally_test`. The cluster was initialized inside ignored `server/.test-postgres/`; it is isolated from the already-running PostgreSQL service on port 5432. No user database credentials were needed.

| Check | Result |
| --- | --- |
| Dependency installation | PASS — `npm.cmd install`; 0 vulnerabilities reported by npm at install time |
| PostgreSQL connectivity | PASS — real migrations, queries and `/ready` |
| Original migrations | PASS — all ten migrations, 50 application tables, 19 enums |
| Migration status | PASS — ten completed, none pending |
| Rollback / reapply | PASS — integration test calls `migrate.rollback(undefined, true)` then `migrate.latest()` on the disposable database |
| Development seed | PASS — `npm.cmd run db:seed`, explicit generated test password; no embedded credential |
| Automated tests | PASS — 20 tests, 0 failures, 0 skips |
| Actual server process | PASS — spawned `node src/index.js` with isolated environment and ephemeral HTTP port |
| GET /health | PASS — real HTTP 200, `{status:"ok"}` |
| GET /ready | PASS — real HTTP 200 after PostgreSQL query |
| Client edits | None — implementation and formatting only targeted server files |
| Migration/ERD edits | None — original ten migration files and their README were not edited |
| SQL/ERD parity comparison | NOT RUN — referenced Wally_Mall.sql / ERD absent from supplied module |
| Live provider payments/uploads/email | NOT RUN — no real provider selected or credential supplied |

Commands actually executed from `server/` (the RTK proxy wrapped shell commands):

```text
npm.cmd install --fetch-retries=0 --fetch-timeout=30000
npm.cmd install --save-dev prettier --fetch-retries=0 --fetch-timeout=30000
npm.cmd run db:latest
npm.cmd run db:status
npm.cmd run db:seed
npm.cmd test
```

`DATABASE_URL=postgresql://wally_test@127.0.0.1:55439/wally_test` was set only for migration/status/seed processes. Tests received the same address through `TEST_DATABASE_URL`, without setting an application DATABASE_URL. The integration guard rejects an identical application/test URL and requires "test" in the database name. The startup test launches the real entrypoint with that test database and fresh random secrets, probes it, then stops its child process.

The initial dependency attempt in the sandbox failed on registry access; retry with approved network access succeeded. The initial `initdb` attempt failed because of the Windows restricted token; approved initialization succeeded. A first migration command had a PowerShell environment-assignment quoting error and exited with `DATABASE_URL is required`; the corrected command succeeded against the dedicated test database. These failures are not counted as successful checks.

## Tested behaviors

Unit tests cover bigint precision/overflow, fee calculation/precedence, status mapping, operational projections, RBAC, password hashing and token tampering.

PostgreSQL/API tests cover registration, login, refresh replay rejection, logout, role resolution, public role injection rejection, address ownership, seller membership, Admin/Super Admin separation, public visibility, database synonyms, real rating counts, variant pricing, cart handling, multi-store checkout, price/address/fee snapshots, reserve/sale/release movements, duplicate signed webhook events, amount mismatch, skipped order-state rejection, order/fulfillment history, two concurrent buyers competing for one unit, refunds and retry after full-payment refund, audit trigger immutability, seller approval, moderation, notifications, stock/price updates, staff provisioning/revocation, CORS and expiry.

A late-failure test deliberately supplies an overlong provider identifier to make the payment insert fail after order/fulfillment/reservation writes. It confirms all row counts and reserved inventory are unchanged after rollback. No production schema modification or fake database is used for this test.

These checks establish the implemented local behavior, not production provider certification, load capacity, backup/recovery validation or a completed frontend integration.

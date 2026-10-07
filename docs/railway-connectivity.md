# Railway connectivity audit — 2026-10-07

## Current production evidence

Read-only HTTPS probes returned:

| Server path | Status | Server header | Access-Control-Allow-Origin |
| --- | --- | --- | --- |
| `/health` | 502 | `railway-hikari` | absent |
| `/ready` | 502 | `railway-hikari` | absent |
| `/api/v1/categories` | 502 | `railway-hikari` | absent |
| `/api/v1/products?limit=5` | 502 | `railway-hikari` | absent |
| `/api/v1/stores?limit=3` | 502 | `railway-hikari` | absent |

Each request used `Origin: https://wallymall-client-production.up.railway.app`.
`GET /health` without Origin and an OPTIONS preflight also returned 502.
The gateway response says `Application failed to respond`; it is not the
application's `{error: {code, request_id}}` response. Therefore the current
failure is between Railway's public proxy and the application. The browser's
missing-CORS-header error is a secondary symptom of that gateway response.

The public client and its JavaScript asset returned 200. The deployed asset
`index-Du4BqPWQ.js` contains the exact correct API base:
`https://wallymall-server-production.up.railway.app/api/v1`.
It contains neither the previous hyphenated server hostname nor the localhost
API target. The deployed client URL is not the current failure.

### Confirmed code defects and limits of the diagnosis

- Before this fix, `src/index.js` defaulted HOST to `127.0.0.1`. With HOST unset,
  it accepts only container-loopback traffic even when PORT is correctly 8080.
  Changed the default to `0.0.0.0`, preserving explicit HOST and PORT overrides.
  The startup message now includes the actual bound address.
- `src/app.js` disabled logging and discarded unexpected error details. Added
  server-side diagnostics containing request ID, registered route pattern,
  status and recognized PostgreSQL/network error code (or a generic fallback).
  Automatic request logging is disabled. Raw errors, SQL, connection strings,
  request headers/bodies/query parameters and stack traces are not logged by
  this handler; browser errors retain their existing contract.
- At the time of this earlier connectivity audit, the ignored local client env
  used a hyphenated server host. The current URL contract and Railway steps are
  documented in [API routing](../../docs/api-routing.md); verify the actual
  Railway domain rather than reusing a host from this historical report.

The loopback default is a proven repository defect and a plausible explanation
for the observed gateway failure. Railway's active HOST, domain target port,
deployed revision and private deployment logs were not available to this audit.
Do not claim that the active deployment's exact misconfiguration has been
proven, or that production is repaired before redeployment and live checks.
A wrong domain target port remains a separate possible cause.

## Trace of the existing configuration

`process.env` → `configFromEnv()` → `{origins}` → `buildApp({db, config})` →
`@fastify/cors`. `CORS_ORIGINS` is split on commas, trimmed, and empty entries
removed. Both CORS and the extra origin validation use the same exact array.
The stated Railway client origin is accepted. A trailing slash is not an origin
and does not match; configure the value without one. CORS is registered before
origin validation and routes. Allowed-origin application errors retain CORS
headers. No wildcard, authentication or origin-validation changes were needed.

`ServerApp.jsx` now passes `import.meta.env.VITE_API_URL` to `createApi()`.
Vite embeds this value at build time. The client validates an origin-only URL
and adds `/api/v1` centrally to paths such as `/products?limit=5`.
An empty development value uses Vite's same-origin proxy.
Changing a runtime variable alone cannot update an already built bundle.

`API_PROXY_TARGET` is used by both Vite **development and preview** servers;
it is not strictly development-only. Static production output does not use
either proxy. The production origin bypasses them.

`DATABASE_URL` → `connect()` → Knex/pg → repositories → route queries.
The same Knex config supplies the migration CLI. Migration and seed paths are
absolute and resolved from `database/knexfile.js`. Connection creation is lazy:
startup and `/health` do not establish PostgreSQL readiness. `/ready` executes
`select 1`. Catalog endpoints execute real repository queries and can detect
missing tables even when `/ready` succeeds. No SQL or schema defect was
established as the cause of the current production 502.

`npm start` runs the long-lived HTTP entrypoint. Migration commands exit after
completion and belong in pre-deploy. No migration/start script changes were
needed. Railway's missing `.env` notice is expected with injected variables.
`configFromEnv()` permits mock payments with `NODE_ENV=production`; outdated
server README and `.env.example` comments were corrected to match that behavior.

## Railway variables

Server service (`Wally_Mall-server`):

| Name | Value or required format |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` (also the new default if absent) |
| `PORT` | Railway-injected numeric port; public domain target port must match |
| `DATABASE_URL` | Reference to the PostgreSQL service's private connection URI; server only |
| `ACCESS_TOKEN_SECRET` | Private random value, at least 32 characters |
| `PAYMENT_WEBHOOK_SECRET` | Separate private random value, at least 32 characters |
| `PAYMENT_PROVIDER` | `mock` |
| `CORS_ORIGINS` | `https://wallymall-client-production.up.railway.app` |
| `MEDIA_ORIGINS` | Comma-separated exact trusted media origins, e.g. `https://images.unsplash.com` if used; empty allows none |
| `BUYER_SERVICE_FEE` | Configured whole-rupiah non-negative integer string; default `0` |
| `SELLER_DELIVERY_FEE` | Configured whole-rupiah non-negative integer string; default `0` |
| `WALLY_LOCAL_FEE` | Configured whole-rupiah non-negative integer string; default `0` |

Fee values must match `0` or 1–12 decimal digits without leading zeroes.
Keep existing intended fee values. Do not substitute DATABASE_PUBLIC_URL,
change NODE_ENV to development, or configure test database/seed credentials
on the deployed service for this audit.

Client service (`Wally_Mall-client`), available **during build**:

```dotenv
VITE_PROTOTYPE_MODE=false
VITE_API_URL=https://<actual-backend-domain>
```

No database, token or webhook secrets belong in the client service or VITE_*
variables. API_PROXY_TARGET is unnecessary for static production hosting.

## Deployment lifecycle

`client/` and `server/` are separate Git repositories in this local workspace.
If each is deployed from its own repository, service root is `/`; if deployed
from a combined repository, select `/client` and `/server` respectively.
Commands below run from the directory containing that service's package.json.

| Setting | Server | Client with Railpack static SPA hosting |
| --- | --- | --- |
| Install | `npm ci` | `npm ci --include=dev` |
| Build command | Leave unset: plain JavaScript, no build script | `npm run build` |
| Pre-deploy command | `npm run migrate` | Leave unset |
| Start command | `npm start` | Leave custom command unset; Railpack supplies Caddy |
| Health check | `/ready` to verify database connectivity | `/` |

For the client, Railpack detects Vite and serves `dist` with Caddy and SPA
fallback. If needed, `RAILPACK_SPA_OUTPUT_DIR=dist` explicitly selects static
SPA mode. This is a documented configuration option, not a claim about the
currently deployed frontend's builder. No production start script exists in
the client package; `npm run preview` is a local inspection command. The public
frontend already works, so no hosting rewrite is required for this incident.

After setting HOST or deploying the binding fix, verify the server public
domain target port matches the actual startup port (8080 in the supplied logs).
Use the private database reference for pre-deploy and runtime alike. A successful
migration proves connectivity only at migration time; repeat `/ready` afterward.

## Verification

From PowerShell, after deployment:

```powershell
$api = 'https://wallymall-server-production.up.railway.app'
rtk proxy curl.exe -i "$api/health"
rtk proxy curl.exe -i "$api/ready"
rtk proxy curl.exe -i "$api/api/v1/categories"
rtk proxy curl.exe -i "$api/api/v1/products?limit=5"
rtk proxy curl.exe -i "$api/api/v1/stores?limit=3"
rtk proxy curl.exe -i -H 'Origin: https://wallymall-client-production.up.railway.app' "$api/api/v1/categories"
rtk proxy curl.exe -i -X OPTIONS -H 'Origin: https://wallymall-client-production.up.railway.app' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization,content-type' "$api/api/v1/products"
```

Expected: health 200 `{status:"ok"}`; readiness 200 `{status:"ready"}`;
catalog 200 `{data:[...]}` (empty arrays are valid); preflight 204; CORS tests
return `Access-Control-Allow-Origin` equal to the exact client origin.

If `/health` is still a Railway 502, investigate binding, target port, active
deployment and process state first. If health succeeds but readiness fails,
inspect private database reachability and the new safe server log code. If
readiness succeeds but catalog fails, inspect migration state with
`npm run migrate:status` and the catalog error code. A PostgreSQL `42P01`
indicates a missing relation; it is not a CORS error.

Local verification uses client tests/build and server tests. PostgreSQL tests
must use a separate disposable database: they reset its public schema.
Never run that suite against Railway's application database.

### Results from this audit

- Client: 16 tests passed; production Vite build passed with the public API URL
  supplied before build. Built JavaScript and all three catalog URL constructions
  were checked for the correct hostname and exactly one `/api/v1` prefix.
- Server: 23 tests passed, zero failures/skips, against a newly created disposable
  local PostgreSQL database. This includes migration/rollback, real frontend API
  integration, authentication, mock payments, CORS and HTTP process startup.
- All five requested paths returned 200 and the exact allowed CORS origin when
  exercised through Fastify against that database.
- `npm run migrate`: already up to date. `npm run migrate:status`: 10 completed,
  no pending migrations. No production database was queried or changed.
- Syntax and Prettier checks passed for changed JavaScript. `git diff --check`
  passed. Neither repository tracks `.env`; changed files and the built client
  were checked against local configured secret values with zero matches, without
  printing those values. Client tracked files are unchanged.
- Installed Fastify emits a non-failing deprecation warning for the supported
  `disableRequestLogging` option (removal planned in Fastify 6). The project
  declares Fastify 5; no dependency upgrade was included in this connectivity fix.
- The local database cluster was initially stopped; it was started for these
  checks. Sandbox restrictions required elevated execution for PostgreSQL startup
  and Vite's config bundler. These were environment limitations, not app defects.
- No Railway settings, source deployment or production data were changed.
  Production readiness remains unverified until the server is reachable.

## References

- [Railway: application failed to respond](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)
- [Vite: build-time environment variables](https://vite.dev/guide/env-and-mode)
- [Railpack: Node and static SPA hosting](https://railpack.com/languages/node/)

Suggested Conventional Commit: `fix: make Railway server reachable and log safe diagnostics`

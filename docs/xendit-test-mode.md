# G01: Xendit Payment Sessions (Test Mode)

This implementation is local work, not proof of an external sandbox payment or production readiness.
No payouts, split transfers, subaccount creation or production deployment are included.

## Server configuration

Set these on the server only, using a private environment file or secret manager (never `VITE_*`):

```dotenv
PAYMENT_PROVIDER=xendit
XENDIT_MODE=test
XENDIT_SECRET_KEY=<Test Mode secret key from Xendit>
XENDIT_CALLBACK_TOKEN=<Test Mode webhook verification token>
XENDIT_BUSINESS_ID=<business owning the Test Mode requests>
PAYMENT_RETURN_ORIGIN=https://<buyer-host>
```

The key must start with `xnd_development_`; live mode/production keys fail startup.
Existing application authentication, database and CORS configuration is still required.
Apply additive migration `013_xendit_sessions` only through the normal reviewed deployment workflow.
No existing database is migrated by the test commands below.
Mock remains available with `PAYMENT_PROVIDER=mock` and its existing HMAC secret for isolated tests.

Register Payment Session and Refund callbacks to the public HTTPS server path
`/api/v1/payments/webhook/xendit`. Xendit's `x-callback-token` is checked using
constant-time comparison; business ID, amount, currency and local/provider references
are also checked. This is callback-token authentication, not an invented HMAC signature.
The mock webhook is disabled when Xendit is selected.

## Flow and recovery

The buyer creates a session with `POST /payments/:id/session` after the existing
transactional checkout has reserved inventory and priced all seller orders.
The backend sends PAY/PAYMENT_LINK, automatic capture, IDR/ID and the stored expiry.
Only validated HTTPS Xendit hosted links are returned. Return redirects never mark paid.
`GET /payments/:id` reads local authoritative state; buyer-owned
`POST /payments/:id/reconcile` retrieves the session from Xendit and applies it.

Session POST is durably claimed before network I/O. The Sessions documentation does
not promise an idempotency header, so an uncertain result is **not POSTed again**.
Concurrent calls and crash/retry cannot create another session. A verified callback
can recover the session, or Super Admin can use
`POST /super-admin/payments/:id/reconcile` with `{ "session_id": "ps-..." }` from
the Test Mode dashboard. The backend fetches it and verifies its local payment reference,
business, amount and currency; the caller cannot submit a paid status.
If no session was created, the checkout expires normally; do not manually reset the claim.

Duplicate terminal session events use a stable provider-session/status key and a
transactional payment lock, so inventory and order transitions occur once.
Late success after expiry/cancellation leaves orders cancelled and is flagged
`reconciliation_required`; it never sells released inventory. Super Admin may approve
the full refund for each cancelled order once the successful provider request is recorded.
An unresolved late event remains in payment_events with no processed_at for investigation.
The existing expiry worker releases reservations idempotently; it does not infer payment success.

Refund requests remain under `POST /super-admin/orders/:id/refund` with a reason.
The approved local refund, approver and audit trail are committed before provider I/O.
Each order is refunded in full (a partial amount of a multi-seller checkout payment).
Refunds do not restore stock. Unsupported channel refunds fail safely for operational follow-up.
The provider's PENDING result stays processing. Verified callbacks or Super Admin
`POST /super-admin/refunds/:id/reconcile` apply the terminal result.
If the POST response was lost, supply `{ "refund_id": "rfd-..." }` from Xendit's dashboard
to that reconciliation endpoint. A second refund POST is blocked while the result is
uncertain. A definitive failed refund permits a new explicitly approved attempt.
Do not resolve ambiguity by manually marking success or clearing dispatch timestamps.

The adapter boundary, checkout/order references and separate session/payment-request/payment
IDs support future G25 settlement work. G01 deliberately sends no `for-user-id` or
`with-split-rule`; seller balances/transfers require the separate G25 implementation.

## Verification and remaining external proof

Local unit tests: `node --test tests/xendit.test.js tests/provider.test.js tests/config.test.js`.
Integration: provision a fresh loopback PostgreSQL database whose name contains `test`,
set only `TEST_DATABASE_URL`, then run `node --test tests/integration.test.js` without loading `.env`.
The suite refuses an existing migration history or the application database; it exercises
migrations and HTTP authorization/transactions with injected Xendit HTTP fixtures.
Fixtures are never evidence of a real Xendit sandbox transaction.

For external proof, configure the above Test Mode credentials and reachable callback/return
URLs in an isolated test deployment. Use Xendit's documented Test Mode payment flow.
Record session/payment/refund IDs, callback delivery and server state for successful payment,
expiry, failed/refused payment, replay, lost callback reconciliation, and pending/success/failed
refund. Verify stock/order changes and owner isolation. Do not record secrets. Do not claim
E2E PASS until those cases actually run; production remains blocked separately.

Official references checked 2026-10-20:
- https://docs.xendit.co/apidocs/create-session
- https://docs.xendit.co/apidocs/get-session
- https://docs.xendit.co/docs/handling-webhooks
- https://docs.xendit.co/apidocs/webhook-notification-sent-defined-webhook-url-updates-payment-session
- https://docs.xendit.co/apidocs/refund-payment-request
- https://docs.xendit.co/apidocs/refund-webhook-notification
- https://github.com/xendit/xendit-node/blob/master/docs/Refund.md (GET refund by ID)

import test from "node:test";
import assert from "node:assert/strict";
import { XenditPaymentAdapter, xenditConfig, checkoutUrl } from "../src/xendit.js";
import { configFromEnv } from "../src/config.js";
const config = { mode: "test", key: "xnd_development_fixture", token: "fixture-token", businessId: "test-business", returnOrigin: "https://buyer.example.test" };
const payment = { id: "local-payment", checkout_id: "checkout", amount: "10000", currency: "IDR", expires_at: "2099-01-01T00:00:00.000Z" };
const session = { reference_id: payment.id, business_id: config.businessId, payment_session_id: "ps-fixture", amount: 10000, currency: "IDR", mode: "PAYMENT_LINK", session_type: "PAY", status: "ACTIVE", payment_link_url: "https://xen.to/fixture" };
test("Xendit config accepts only server Test Mode credentials and HTTPS return origin", () => {
  const env = { ACCESS_TOKEN_SECRET: "a".repeat(40), PAYMENT_PROVIDER: "xendit", XENDIT_SECRET_KEY: config.key,
    XENDIT_CALLBACK_TOKEN: config.token, XENDIT_BUSINESS_ID: config.businessId, PAYMENT_RETURN_ORIGIN: config.returnOrigin };
  assert.equal(configFromEnv(env).xendit.mode, "test");
  for (const patch of [{ XENDIT_MODE: "live" }, { XENDIT_SECRET_KEY: "xnd_production_no" }, { XENDIT_CALLBACK_TOKEN: "" },
    { XENDIT_BUSINESS_ID: "" }, { PAYMENT_RETURN_ORIGIN: "http://localhost" }, { PAYMENT_RETURN_ORIGIN: "https://buyer.example.test/path" }])
    assert.throws(() => xenditConfig({ ...env, ...patch }));
});
test("hosted session request is server priced, bounded, and contains no split/payout directives", async () => {
  const adapter = new XenditPaymentAdapter(config, async (url, options) => {
    assert.equal(url, "https://api.xendit.co/sessions");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.equal(body.amount, 10000);
    assert.equal(body.reference_id, payment.id);
    assert.equal(body.expires_at, payment.expires_at);
    assert.equal(body.mode, "PAYMENT_LINK");
    assert.equal(body.capture_method, "AUTOMATIC");
    assert.equal(body.success_return_url, `${config.returnOrigin}/payment/${payment.id}`);
    assert.equal(options.headers["for-user-id"], undefined);
    return { ok: true, json: async () => session };
  });
  assert.equal((await adapter.createPayment(payment)).checkout_url, "https://xen.to/fixture");
  await assert.rejects(adapter.createPayment({ ...payment, currency: "USD" }));
  await assert.rejects(adapter.createPayment({ ...payment, amount: "9007199254740993" }));
});
test("callback token is constant-time checked; payload, business, status and amount are bound", () => {
  const adapter = new XenditPaymentAdapter(config);
  const raw = JSON.stringify({ business_id: config.businessId, event: "payment_session.expired", data: session });
  for (const token of [undefined, "", "incorrect-token"]) assert.throws(() => adapter.handleWebhook(raw, token), /INVALID_SIGNATURE/);
  assert.equal(adapter.handleWebhook(raw, config.token).business_id, config.businessId);
  assert.throws(() => adapter.handleWebhook("{", config.token), /INVALID_PAYLOAD/);
  assert.throws(() => adapter.handleWebhook(raw.replace(config.businessId, "other"), config.token));
  for (const patch of [{ amount: 1 }, { reference_id: "other" }, { currency: "USD" }, { status: "UNKNOWN" },
    { session_type: "SAVE" }, { business_id: "other" }, { payment_link_url: "https://evil.test/" }, { status: "COMPLETED" }])
    assert.throws(() => adapter.session({ ...session, ...patch }, payment));
  assert.equal(adapter.session({ ...session, status: "EXPIRED" }, payment).status, "expired");
  assert.equal(adapter.session({ ...session, status: "COMPLETED", payment_request_id: "pr-test" }, payment).status, "success");
  for (const url of ["javascript:alert(1)", "https://xen.to.evil.test", "https://user@xen.to/a", "http://xen.to/a"]) assert.throws(() => checkoutUrl(url));
});
test("provider errors and timeouts are sanitized and require reconciliation", async () => {
  for (const fetcher of [async () => { throw new Error("private credential"); }, async () => ({ ok: false })]) {
    const adapter = new XenditPaymentAdapter(config, fetcher);
    await assert.rejects(adapter.createPayment(payment), /RECONCILE_REQUIRED/);
  }
});
test("refund pending is not success; amount, reference and provider request must match", async () => {
  const refund = { id: "refund", amount: "10000", order_id: "order" };
  const paid = { ...payment, provider_payment_request_id: "pr-test" };
  const data = { id: "rfd-test", reference_id: refund.id, payment_request_id: "pr-test", amount: 10000, currency: "IDR", status: "PENDING" };
  const adapter = new XenditPaymentAdapter(config, async (url, opts) => {
    assert.equal(url, "https://api.xendit.co/refunds");
    assert.equal(JSON.parse(opts.body).reference_id, refund.id);
    return { ok: true, json: async () => data };
  });
  assert.equal((await adapter.refund(refund, paid)).status, "processing");
  for (const [status, expected] of [["SUCCEEDED", "success"], ["FAILED", "failed"]])
    assert.equal(adapter.refundResult({ ...data, status }, refund, paid).status, expected);
  for (const patch of [{ amount: 1 }, { currency: "USD" }, { reference_id: "other" }, { payment_request_id: "pr-other" }])
    assert.throws(() => adapter.refundResult({ ...data, ...patch }, refund, paid));
});

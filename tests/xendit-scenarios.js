import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { XenditPaymentAdapter } from "../src/xendit.js";
import { commerceRepository } from "../database/transactions/commerce.js";
export async function xenditScenarios({ t, db, config, other, admin, superAdmin, newStore, product }) {
  const xc = { mode: "test", key: "xnd_development_fixture", token: "fixture-callback", businessId: "fixture-business", returnOrigin: "https://buyer.example.test" };
  const sessions = new Map(), refunds = [];
  let posts = 0, loseSessionResponse = false, loseRefundResponse = false;
  const adapter = new XenditPaymentAdapter(xc, async (url, opts) => {
    const path = new URL(url).pathname;
    let data;
    if (path === "/sessions") {
      posts++;
      const input = JSON.parse(opts.body);
      data = { ...input, business_id: xc.businessId, payment_session_id: `ps-${input.reference_id}`,
        status: "ACTIVE", payment_link_url: "https://xen.to/fixture" };
      sessions.set(data.payment_session_id, data);
      if (loseSessionResponse) throw new Error("simulated lost response");
    } else if (path.startsWith("/sessions/")) data = sessions.get(path.slice(10));
    else if (path === "/refunds") {
      const input = JSON.parse(opts.body);
      data = { ...input, id: `rfd-${input.reference_id}`, status: "PENDING" };
      refunds.push(data);
      if (loseRefundResponse) throw new Error("simulated lost refund response");
    } else if (path.startsWith("/refunds/")) data = refunds.find(r => r.id === path.slice(9));
    else throw new Error(`Unexpected fixture endpoint ${path}`);
    return { ok: !!data, json: async () => data };
  });
  const app = await buildApp({ db, config: { ...config, provider: "xendit", xendit: xc }, adapter, storage: {} });
  const req = async (method, path, payload, token) => {
    const res = await app.inject({ method, url: `/api/v1${path}`, payload,
      headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, ...res.json() };
  };
  const hook = async (event, data, token = xc.token) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/payments/webhook/xendit",
      headers: { "x-callback-token": token }, payload: { event, business_id: xc.businessId, data } });
    return { status: res.statusCode, ...res.json() };
  };
  try {
    const registration = await req("POST", "/auth/register", { name: "Xendit Buyer", email: "xendit-fixture@example.test", password: "Test-only-password-123!" });
    assert.equal(registration.status, 201);
    const buyer = registration.data;
    const address = await req("POST", "/addresses", { recipient_name: "Buyer", phone: "081234567", province: "Papua Barat Daya", city: "Sorong", district: "Sorong Kota", address_line: "Test address" }, buyer.access_token);
    assert.equal(address.status, 200);
    const store = await newStore("xendit-store");
    let sequence = 0;
    const checkout = async () => {
      const p = await product(store, `xendit-product-${++sequence}`, 10);
      assert.equal((await req("POST", "/cart/items", { variant_id: p.variant.id, quantity: 1 }, buyer.access_token)).status, 200);
      const c = await req("POST", "/checkouts", { address_id: address.data.id, fulfillment: { [store.id]: "pickup" }, method: "qris" }, buyer.access_token);
      assert.equal(c.status, 200, JSON.stringify(c));
      return { ...c.data, variant: p.variant.id };
    };
    let paid, session;
    await t.test("Xendit sessions: ownership, concurrent create/resume, authentic webhook, replay, amount and stock", async () => {
      paid = await checkout();
      const path = `/payments/${paid.payment.id}/session`;
      assert.equal((await req("POST", path, {}, other.access_token)).status, 404);
      const responses = await Promise.all([req("POST", path, {}, buyer.access_token), req("POST", path, {}, buyer.access_token)]);
      assert.ok(responses.some(r => r.status === 200));
      assert.equal(posts, 1);
      assert.equal((await req("POST", path, {}, buyer.access_token)).data.checkout_url, "https://xen.to/fixture");
      assert.equal(posts, 1);
      session = sessions.get(`ps-${paid.payment.id}`);
      session.status = "COMPLETED"; session.payment_request_id = "pr-fixture";
      assert.equal((await hook("payment_session.completed", session, "bad")).status, 401);
      assert.equal((await hook("payment_session.completed", { ...session, amount: 1 })).status, 502);
      assert.equal((await hook("payment_session.completed", session)).status, 200);
      assert.equal((await hook("payment_session.completed", session)).data.duplicate, true);
      assert.equal((await db("payments").where({ id: paid.payment.id }).first()).status, "success");
      assert.equal((await db("inventories").where({ variant_id: paid.variant }).first()).on_hand, 9);
      assert.equal((await db("payment_events").where({ payment_id: paid.payment.id })).length, 1);
      assert.equal((await hook("payment_session.expired", { ...session, status: "EXPIRED", payment_request_id: null })).status, 200);
      assert.equal((await db("payments").where({ id: paid.payment.id }).first()).provider_payment_request_id, "pr-fixture");
      assert.equal((await req("POST", path, { status: "success" }, buyer.access_token)).status, 409);
    });
    await t.test("Xendit refund: Super Admin only, pending is persisted, concurrent replay, async success and no restock", async () => {
      const order = await db("orders").where({ checkout_id: paid.id }).first();
      const path = `/super-admin/orders/${order.id}/refund`;
      assert.equal((await req("POST", path, { reason: "Approved full refund" }, admin.access_token)).status, 403);
      const results = await Promise.all([req("POST", path, { reason: "Approved full refund" }, superAdmin.access_token), req("POST", path, { reason: "Approved full refund" }, superAdmin.access_token)]);
      assert.ok(results.every(r => r.status === 200), JSON.stringify(results));
      assert.equal(refunds.length, 1);
      assert.equal((await db("refunds").where({ order_id: order.id }).first()).status, "processing");
      assert.equal((await db("payments").where({ id: paid.payment.id }).first()).status, "success");
      const result = { ...refunds[0], status: "SUCCEEDED" };
      assert.equal((await hook("refund.succeeded", { ...result, amount: 1 })).status, 502);
      assert.equal((await hook("refund.succeeded", result)).status, 200);
      assert.equal((await hook("refund.succeeded", result)).data.duplicate, true);
      assert.equal((await db("inventories").where({ variant_id: paid.variant }).first()).on_hand, 9);
      assert.equal((await db("refunds").where({ order_id: order.id }).first()).status, "success");
      assert.ok(await db("audit_logs").where({ action: "refund.result", entity_id: result.reference_id }).first());
    });
    await t.test("Xendit timeout recovery: no second POST; admin recovers session, buyer reconciles server status", async () => {
      const c = await checkout(); loseSessionResponse = true;
      const count = posts;
      assert.equal((await req("POST", `/payments/${c.payment.id}/session`, {}, buyer.access_token)).status, 502);
      loseSessionResponse = false;
      assert.equal((await req("POST", `/payments/${c.payment.id}/session`, {}, buyer.access_token)).status, 409);
      assert.equal(posts, count + 1);
      assert.equal((await req("POST", `/super-admin/payments/${c.payment.id}/reconcile`, { session_id: `ps-${c.payment.id}` }, admin.access_token)).status, 403);
      assert.equal((await req("POST", `/super-admin/payments/${c.payment.id}/reconcile`, { session_id: `ps-${c.payment.id}` }, superAdmin.access_token)).status, 200);
      const s = sessions.get(`ps-${c.payment.id}`); s.status = "COMPLETED"; s.payment_request_id = "pr-timeout";
      assert.equal((await req("POST", `/payments/${c.payment.id}/reconcile`, {}, other.access_token)).status, 404);
      assert.equal((await req("POST", `/payments/${c.payment.id}/reconcile`, {}, buyer.access_token)).data.status, "success");
      const order = await db("orders").where({ checkout_id: c.id }).first();
      loseRefundResponse = true;
      const before = refunds.length;
      assert.equal((await req("POST", `/super-admin/orders/${order.id}/refund`, { reason: "Test timeout" }, superAdmin.access_token)).status, 502);
      loseRefundResponse = false;
      assert.equal((await req("POST", `/super-admin/orders/${order.id}/refund`, { reason: "Retry" }, superAdmin.access_token)).status, 200);
      assert.equal(refunds.length, before + 1);
      refunds.at(-1).status = "FAILED";
      assert.equal((await req("POST", `/super-admin/refunds/${refunds.at(-1).reference_id}/reconcile`, { refund_id: refunds.at(-1).id }, superAdmin.access_token)).status, 200);
      assert.equal((await hook("refund.failed", refunds.at(-1))).data.duplicate, true);
      assert.equal((await db("refunds").where({ order_id: order.id }).first()).status, "failed");
      assert.equal((await db("payments").where({ id: c.payment.id }).first()).status, "success");
    });
    await t.test("Xendit expiry releases stock once; late success is flagged and never fulfills released stock", async () => {
      const c = await checkout();
      await req("POST", `/payments/${c.payment.id}/session`, {}, buyer.access_token);
      const s = sessions.get(`ps-${c.payment.id}`); s.status = "EXPIRED";
      assert.equal((await hook("payment_session.expired", s)).status, 200);
      assert.equal((await hook("payment_session.expired", s)).data.duplicate, true);
      s.status = "COMPLETED"; s.payment_request_id = "pr-late";
      assert.equal((await hook("payment_session.completed", s)).data.reconciliation_required, true);
      const row = await db("payments").where({ id: c.payment.id }).first();
      assert.equal(row.status, "expired"); assert.equal(row.reconciliation_required, true);
      const stock = await db("inventories").where({ variant_id: c.variant }).first();
      assert.equal(stock.on_hand, 10); assert.equal(stock.reserved, 0);
      const order = await db("orders").where({ checkout_id: c.id }).first();
      assert.equal((await req("POST", `/super-admin/orders/${order.id}/refund`, { reason: "Refund late payment" }, superAdmin.access_token)).status, 200);
      assert.equal((await hook("refund.succeeded", { ...refunds.at(-1), status: "SUCCEEDED" })).status, 200);
      assert.equal((await db("inventories").where({ variant_id: c.variant }).first()).on_hand, 10);
      const late = await checkout();
      await req("POST", `/payments/${late.payment.id}/session`, {}, buyer.access_token);
      await db("payments").where({ id: late.payment.id }).update({ expires_at: new Date(0) });
      await db("checkouts").where({ id: late.id }).update({ expires_at: new Date(0) });
      await commerceRepository(db, config).expire();
      await commerceRepository(db, config).expire();
      assert.equal((await db("inventories").where({ variant_id: late.variant }).first()).reserved, 0);
    });
  } finally { await app.close(); }
}

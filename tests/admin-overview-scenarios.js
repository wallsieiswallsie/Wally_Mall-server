import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// G16: dashboard overview RBAC, data minimization and authoritative finance.
export async function adminOverviewScenarios({ t, app, db, buyer, other, seller, admin, superAdmin, newStore }) {
  const request = async (path, token) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.statusCode, ...response.json() };
  };
  const keys = (value, found = new Set()) => {
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        found.add(k);
        keys(v, found);
      }
    return found;
  };

  await t.test("G16 overview: role access is enforced by the server", async () => {
    for (const path of ["/admin/overview", "/super-admin/overview"]) {
      assert.equal((await request(path)).status, 401);
      assert.equal((await request(path, buyer.access_token)).status, 403);
      assert.equal((await request(path, seller.access_token)).status, 403);
      assert.equal((await request(path, superAdmin.access_token)).status, 200);
    }
    assert.equal((await request("/admin/overview", admin.access_token)).status, 200);
    assert.equal((await request("/super-admin/overview", admin.access_token)).status, 403);
    for (const days of ["13", "0", "abc", "366"]) {
      const bad = await request(`/admin/overview?days=${days}`, admin.access_token);
      assert.equal(bad.status, 400, days);
    }
    for (const days of [7, 30, 90, 180, 365])
      assert.equal((await request(`/admin/overview?days=${days}`, admin.access_token)).data.days, days);
  });

  await t.test("G16 overview: Admin receives no money, buyer identity or report text", async () => {
    const { data } = await request("/admin/overview", admin.access_token);
    const found = keys(data);
    for (const key of ["finance", "gmv", "revenue", "subtotal", "platform_fee", "email", "phone", "buyer_id", "description", "address_line", "total_buyers"])
      assert.equal(found.has(key), false, `admin overview exposes ${key}`);
    assert.equal(data.operations.support_cases, null);
    assert.equal(data.unavailable.support_cases, "SUPPORT_CASE_MODEL_MISSING");
  });

  await t.test("G16 overview: counts and finance follow server records; mock payments and refunds excluded", async () => {
    const before = (await request("/super-admin/overview?days=7", superAdmin.access_token)).data;
    const adminBefore = (await request("/admin/overview?days=7", admin.access_token)).data;
    const store = await newStore(`overview-${randomUUID().slice(0, 8)}`);
    const checkout = async (user, provider, status, ago = 0) => {
      const created = new Date(Date.now() - ago * 86400000);
      const [c] = await db("checkouts")
        .insert({ checkout_number: `CO-${randomUUID()}`, buyer_id: user.user.id, grand_total: "1", status: "paid", created_at: created })
        .returning("*");
      await db("payments").insert({ checkout_id: c.id, provider, method: "qris", amount: "1", status, created_at: created });
      return { ...c, created };
    };
    const order = async (c, user, status, subtotal, platform = "0", service = "0") => {
      const [o] = await db("orders")
        .insert({
          order_number: `ORD-${randomUUID()}`,
          checkout_id: c.id,
          buyer_id: user.user.id,
          store_id: store.id,
          status,
          fulfillment_type: "pickup",
          subtotal,
          platform_fee: platform,
          service_fee: service,
          total_amount: subtotal,
          created_at: c.created,
          ...(status === "completed" ? { completed_at: c.created } : {}),
        })
        .returning("*");
      return o;
    };
    const verified = await checkout(buyer, "xendit", "success");
    await order(verified, buyer, "completed", "100000", "3000", "1500");
    await order(verified, buyer, "processing", "50000", "1500");
    const refundedCheckout = await checkout(buyer, "xendit", "refunded");
    const refunded = await order(refundedCheckout, buyer, "completed", "20000", "600");
    const [payment] = await db("payments").where({ checkout_id: refundedCheckout.id });
    await db("refunds").insert({ order_id: refunded.id, payment_id: payment.id, amount: "20000", reason: "test", status: "success" });
    const simulated = await checkout(other, "mock", "success");
    await order(simulated, other, "confirmed", "999999", "9999");
    const failed = await checkout(other, "xendit", "failed");
    await order(failed, other, "cancelled", "70000");
    const previous = await checkout(other, "xendit", "success", 10);
    await order(previous, other, "completed", "40000", "1200");
    const [report] = await db("reports")
      .insert({ reporter_id: buyer.user.id, target_type: "store", target_id: store.id, category: "spam", description: "private note 0812" })
      .returning("*");

    const after = (await request("/super-admin/overview?days=7", superAdmin.access_token)).data;
    const f0 = before.finance,
      f1 = after.finance;
    assert.equal(BigInt(f1.gmv) - BigInt(f0.gmv), 150000n);
    assert.equal(BigInt(f1.revenue) - BigInt(f0.revenue), 6000n);
    assert.equal(f1.transactions - f0.transactions, 2);
    assert.equal(f1.orders - f0.orders, 5);
    assert.equal(f1.simulated_paid_orders - f0.simulated_paid_orders, 1);
    assert.equal(BigInt(f1.previous.gmv) - BigInt(f0.previous.gmv), 40000n);
    assert.equal(after.statuses.cancelled - (before.statuses.cancelled ?? 0), 1);
    assert.equal(after.orders_in_range - before.orders_in_range, 5);
    assert.ok(f1.rates.payment_success > 0 && f1.rates.payment_success < 100);
    assert.equal(after.unavailable.payment_success, undefined);
    assert.equal(after.unavailable.conversion_funnel, "EVENT_TRACKING_MISSING");
    assert.equal(
      f1.trend.reduce((n, d) => n + BigInt(d.gmv), 0n),
      BigInt(f1.gmv),
      "trend bins sum to the period GMV",
    );
    assert.equal(f1.trend.length, 7);
    assert.ok(f1.aov !== null);

    const ops = (await request("/admin/overview?days=7", admin.access_token)).data;
    const d = (key) => ops.operations[key] - adminBefore.operations[key];
    assert.equal(d("processing"), 1);
    assert.equal(d("awaiting_processing"), 1);
    assert.equal(d("completed_today"), 2);
    assert.equal(d("open_reports"), 1);
    const listed = ops.queues.reports.find((r) => r.id === report.id);
    if (listed) assert.equal("description" in listed, false);
  });
}

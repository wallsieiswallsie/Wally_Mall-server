import test from "node:test";
import assert from "node:assert/strict";
import {
  money,
  feeAmount,
  resolveFee,
  displayStatus,
  orderProjection,
  requireRoles,
} from "../src/domain.js";
import {
  hashPassword,
  verifyPassword,
  signAccess,
  verifyAccess,
} from "../src/security.js";
test("money preserves bigint precision and rejects overflow", () => {
  assert.equal(money("9007199254740993"), 9007199254740993n);
  assert.throws(() => money("9223372036854775808"));
  assert.throws(() => money("1.2"));
  assert.equal(feeAmount("999", "3.5000", "10"), 45n);
  assert.equal(feeAmount("20", "100", "99"), 20n);
});
test("fee precedence and period are deterministic", () => {
  const rules = [
    {
      id: "g",
      scope_type: "global",
      status: "active",
      effective_from: "2025-01-01",
    },
    {
      id: "s",
      scope_type: "store",
      scope_id: "s1",
      status: "scheduled",
      effective_from: "2025-01-01",
    },
    {
      id: "future",
      scope_type: "store",
      scope_id: "s1",
      status: "scheduled",
      effective_from: "2099-01-01",
    },
  ];
  assert.equal(resolveFee(rules, "s1", "c1").id, "s");
  assert.equal(resolveFee(rules, "s2", "c1").id, "g");
});
test("status projection respects separated states", () => {
  assert.equal(
    displayStatus(
      { status: "ready" },
      { status: "success" },
      { type: "pickup" },
    ),
    "ready_for_pickup",
  );
  assert.equal(
    displayStatus({ status: "cancelled" }, { status: "failed" }),
    "payment_failed",
  );
  assert.equal(
    displayStatus(
      { status: "completed" },
      { status: "partially_refunded" },
      null,
      { status: "success" },
    ),
    "refunded",
  );
});
test("operational projections exclude all money and private identity", () => {
  const row = orderProjection(
    {
      id: "1",
      buyer_id: "secret",
      subtotal: "100",
      platform_fee: "3",
      seller_net_amount: "97",
    },
    "admin",
  );
  assert.deepEqual(row, { id: "1" });
  assert.throws(() => requireRoles({ roles: ["admin"] }, "super_admin"));
});
test("password hashing and signed access reject tampering", async () => {
  const encoded = await hashPassword("a secure password");
  assert.ok(!encoded.includes("a secure password"));
  assert.equal(await verifyPassword("a secure password", encoded), true);
  assert.equal(await verifyPassword("incorrect password", encoded), false);
  const secret = "s".repeat(32),
    id = "11111111-1111-4111-8111-111111111111";
  assert.equal(verifyAccess(signAccess(id, secret), secret), id);
  assert.throws(() => verifyAccess(signAccess(id, secret) + "x", secret));
});

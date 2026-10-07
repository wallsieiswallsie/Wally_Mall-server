import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { connect } from "../database/index.js";
import { buildApp } from "../src/app.js";
import { commerceRepository } from "../database/transactions/commerce.js";
import { createApi } from '../../client/src/api/client.js';
import { verifyPassword } from '../src/security.js';
const url = process.env.TEST_DATABASE_URL;
const config = {
  secret: "a".repeat(40),
  webhook: "b".repeat(40),
  provider: "mock",
  origins: ["http://localhost:5173"],
  mediaOrigins: ["https://example.test"],
  serviceFee: "1500",
  delivery: { pickup: "0", seller_delivery: "10000", wally_local: "15000" },
};
test("PostgreSQL migration and API integration", { skip: !url }, async (t) => {
  const parsed = new URL(url);
  assert.match(
    parsed.pathname,
    /test/i,
    "TEST_DATABASE_URL database name must contain test",
  );
  assert.notEqual(
    url,
    process.env.DATABASE_URL,
    "Test database must be separate from configured application database",
  );
  const db = connect(url);
  let app;
  try {
    await db.raw("DROP SCHEMA public CASCADE");
    await db.raw("CREATE SCHEMA public");
    const migration = await db.migrate.latest();
    assert.equal(migration[1].length, 11);
    assert.equal((await db.migrate.list())[1].length, 0);
    await db.migrate.rollback(undefined, true);
    assert.equal((await db.migrate.list())[1].length, 11);
    await db.migrate.latest();
    app = await buildApp({ db, config });
    const request = async (method, path, body, token) => {
      const response = await app.inject({
        method,
        url: `/api/v1${path}`,
        payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: response.statusCode, ...response.json() };
    };
    const register = async (name) => {
      const r = await request("POST", "/auth/register", {
        name,
        email: `${name}@example.test`,
        password: "Test-only-password-123!",
      });
      assert.equal(r.status, 201, JSON.stringify(r));
      return r.data;
    };
    const buyer = await register("buyer"),
      other = await register("other"),
      seller = await register("seller"),
      outsider = await register("outsider"),
      admin = await register("admin"),
      superAdmin = await register("super");
    const grant = async (user, code) => {
      const role = await db("roles").where({ code }).first();
      await db("user_roles").insert({
        user_id: user.user.id,
        role_id: role.id,
      });
    };
    await grant(seller, "seller");
    await grant(outsider, "seller");
    await grant(admin, "admin");
    await grant(superAdmin, "super_admin");
    const [category] = await db("categories")
      .insert({ slug: "fashion", name: "Fashion" })
      .returning("*");
    const newStore = async (name) => {
      const [s] = await db("stores")
        .insert({
          public_id: name,
          slug: name,
          name,
          status: "active",
          verification_status: "verified",
          primary_category_id: category.id,
        })
        .returning("*");
      await db("store_members").insert({
        store_id: s.id,
        user_id: seller.user.id,
        role: "owner",
      });
      return s;
    };
    const s1 = await newStore("store-one"),
      s2 = await newStore("store-two");
    const product = async (store, name, stock = 20, price = "10000") => {
      const [p] = await db("products")
        .insert({
          public_id: name,
          slug: name,
          name,
          store_id: store.id,
          category_id: category.id,
          description: "test",
          condition: "new",
          status: "active",
          moderation_status: "approved",
          min_price: "1",
          max_price: "1",
        })
        .returning("*");
      const [v] = await db("product_variants")
        .insert({ product_id: p.id, name: "Default", price })
        .returning("*");
      await db("inventories").insert({ variant_id: v.id, on_hand: stock });
      return { ...p, variant: v };
    };
    const p1 = await product(s1, "shoe"),
      p2 = await product(s2, "shirt");
    const addressData = {
      recipient_name: "Buyer",
      phone: "081234567",
      province: "Papua Barat Daya",
      city: "Sorong",
      district: "Sorong Kota",
      address_line: "Original address",
      is_default: true,
    };
    const a1 = await request(
        "POST",
        "/addresses",
        addressData,
        buyer.access_token,
      ),
      a2 = await request("POST", "/addresses", addressData, other.access_token);
    assert.equal(a1.status, 200, JSON.stringify(a1));
    await t.test('registration persists one hash, rejects duplicate email, and matches login credentials', async () => {
      const password = 'Test-only-password-123!';
      const stored = await db('users').where({ id: buyer.user.id }).first();
      assert.equal(stored.email, 'buyer@example.test');
      assert.equal(stored.status, 'active');
      assert.match(stored.password_hash, /^scrypt\$/);
      assert.notEqual(stored.password_hash, password);
      assert.equal(await verifyPassword(password, stored.password_hash), true);
      assert.equal(buyer.user.password_hash, undefined);
      assert.ok(buyer.access_token && buyer.refresh_token);
      assert.equal((await request('GET', '/users/me', null, buyer.access_token)).data.id, buyer.user.id);

      const duplicate = await request('POST', '/auth/register', {
        name: 'Duplicate Buyer', email: 'BUYER@EXAMPLE.TEST', password,
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.error.code, 'RESOURCE_CONFLICT');
      assert.equal((await db('users').where({ email: stored.email })).length, 1);
      const valid = await request('POST', '/auth/login', { email: 'BUYER@EXAMPLE.TEST', password });
      assert.equal(valid.status, 200);
      assert.equal(valid.data.user.id, buyer.user.id);

      for (const input of [
        { email: stored.email, password: 'Wrong-password-123!' },
        { email: 'unregistered@example.test', password },
      ]) {
        const failure = await request('POST', '/auth/login', input);
        assert.equal(failure.status, 401);
        assert.equal(failure.error.code, 'INVALID_CREDENTIALS');
        assert.ok(failure.error.request_id);
      }
      for (const path of ['/auth/register', '/auth/login']) {
        const input = { email: 'validation@example.test', password: 'too-short' };
        if (path.endsWith('register')) input.name = 'Validation';
        assert.equal((await request('POST', path, input)).status, 400);
        input.password = password;
        input.email = ' buyer@example.test ';
        assert.equal((await request('POST', path, input)).status, 400);
      }
    });
    await t.test(
      "authentication, public role injection, refresh rotation, logout",
      async () => {
        assert.equal(
          (
            await request("POST", "/auth/register", {
              name: "injected",
              email: "bad@example.test",
              password: "Test-only-password-123!",
              role: "super_admin",
            })
          ).status,
          400,
        );
        const login = await request("POST", "/auth/login", {
          email: "buyer@example.test",
          password: "Test-only-password-123!",
        });
        assert.equal(login.status, 200, JSON.stringify(login));
        assert.deepEqual(login.data.user.roles, ["buyer"]);
        const refresh = await request("POST", "/auth/refresh", {
          refresh_token: login.data.refresh_token,
        });
        assert.equal(refresh.status, 200);
        assert.equal(
          (
            await request("POST", "/auth/refresh", {
              refresh_token: login.data.refresh_token,
            })
          ).status,
          401,
        );
        assert.equal(
          (await request("POST", "/auth/logout", {}, refresh.data.access_token))
            .status,
          200,
        );
        assert.equal(
          (await request("GET", "/users/me", null, refresh.data.access_token))
            .status,
          401,
        );
        const session = await db("user_sessions")
          .where({ user_id: buyer.user.id })
          .first();
        assert.notEqual(session.refresh_token_hash, buyer.refresh_token);
      },
    );
    await t.test("ownership, membership and Admin separation", async () => {
      assert.equal(
        (
          await request(
            "PATCH",
            `/addresses/${a1.data.id}`,
            addressData,
            other.access_token,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "PATCH",
            `/seller/products/${p1.id}`,
            { name: "intrusion" },
            outsider.access_token,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "GET",
            "/super-admin/transactions",
            null,
            admin.access_token,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "GET",
            "/super-admin/transactions",
            null,
            superAdmin.access_token,
          )
        ).status,
        200,
      );
    });
    await t.test("visibility, synonyms and real ratings", async () => {
      await db("search_synonyms").insert({ term: "sneaker", synonym: "shoe" });
      const found = await request("GET", "/search?q=sneaker");
      assert.equal(found.status, 200, JSON.stringify(found));
      assert.equal(found.data[0].id, p1.id);
      assert.equal(found.data[0].rating_count, 0);
      assert.equal(found.data[0].min_price, "10000");
      await db("stores").where({ id: s1.id }).update({ status: "suspended" });
      assert.equal(
        (await request("GET", `/products/by-slug/${p1.slug}`)).status,
        404,
      );
      await db("stores").where({ id: s1.id }).update({ status: "active" });
      await db("categories")
        .where({ id: category.id })
        .update({ status: "inactive" });
      assert.equal((await request("GET", "/products")).data.length, 0);
      await db("categories")
        .where({ id: category.id })
        .update({ status: "active" });
      assert.equal(
        await db("search_queries")
          .count("* as n")
          .first()
          .then((x) => Number(x.n)),
        1,
      );
    });
    let checkout;
    await t.test(
      "multi-seller checkout, authoritative variants, immutable snapshots and fee rules",
      async () => {
        await db("platform_fee_rules").insert({
          name: "Global",
          percentage: "3",
          fixed_amount: "100",
          scope_type: "global",
          effective_from: new Date("2020-01-01"),
          status: "active",
          created_by: superAdmin.user.id,
        });
        assert.equal(
          (
            await request(
              "POST",
              "/cart/items",
              { variant_id: p1.variant.id, quantity: 2 },
              buyer.access_token,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/cart/items",
              { variant_id: p2.variant.id, quantity: 1 },
              buyer.access_token,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              "POST",
              "/checkouts",
              { address_id: a2.data.id, fulfillment: {}, method: "qris" },
              buyer.access_token,
            )
          ).status,
          404,
        );
        const result = await request(
          "POST",
          "/checkouts",
          {
            address_id: a1.data.id,
            fulfillment: { [s2.id]: "seller_delivery" },
            method: "qris",
          },
          buyer.access_token,
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        checkout = result.data;
        assert.equal(checkout.orders.length, 2);
        assert.equal(checkout.grand_total, "41500");
        const orders = await db("orders").where({ checkout_id: checkout.id });
        assert.equal(new Set(orders.map((o) => o.store_id)).size, 2);
        assert.equal(
          orders.find((o) => o.store_id === s1.id).platform_fee,
          "700",
        );
        await db("product_variants")
          .where({ id: p1.variant.id })
          .update({ price: "20000" });
        await db("products").where({ id: p1.id }).update({ name: "Changed" });
        await request(
          "PATCH",
          `/addresses/${a1.data.id}`,
          { ...addressData, address_line: "Changed address" },
          buyer.access_token,
        );
        const item = await db("order_items")
          .where({ variant_id: p1.variant.id })
          .first();
        assert.equal(item.unit_price, "10000");
        assert.equal(item.product_name, "shoe");
        assert.equal(
          (
            await db("order_addresses")
              .where({ order_id: item.order_id })
              .first()
          ).address_line,
          "Original address",
        );
        assert.equal(
          (await db("inventories").where({ variant_id: p1.variant.id }).first())
            .reserved,
          2,
        );
        assert.equal(
          (
            await request(
              "GET",
              `/checkouts/${checkout.id}`,
              null,
              other.access_token,
            )
          ).status,
          404,
        );
        const operational = await request(
          "GET",
          "/admin/orders",
          null,
          admin.access_token,
        );
        assert.ok(!JSON.stringify(operational).includes("subtotal"));
        assert.ok(!JSON.stringify(operational).includes("Original address"));
      },
    );
    const event = async (payment, status, id = randomUUID()) => {
      const payload = JSON.stringify({
        event_id: id,
        payment_id: payment.id,
        status,
        amount: payment.amount,
        currency: payment.currency,
      });
      return app.inject({
        method: "POST",
        url: "/api/v1/payments/webhook/mock",
        headers: {
          "content-type": "application/json",
          "x-payment-signature": createHmac("sha256", config.webhook)
            .update(payload)
            .digest("hex"),
        },
        payload,
      });
    };
    await t.test(
      "verified success, event replay and fulfillment histories",
      async () => {
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/v1/payments/webhook/mock",
              headers: { "content-type": "application/json" },
              payload: "{}",
            })
          ).statusCode,
          401,
        );
        const eventId = randomUUID();
        const first = await event(checkout.payment, "success", eventId);
        assert.equal(first.statusCode, 200, first.body);
        assert.equal(
          (await event(checkout.payment, "success", eventId)).json().data
            .duplicate,
          true,
        );
        assert.equal(
          (await db("inventories").where({ variant_id: p1.variant.id }).first())
            .on_hand,
          18,
        );
        assert.equal(
          (await db("inventories").where({ variant_id: p1.variant.id }).first())
            .reserved,
          0,
        );
        const order = checkout.orders.find((o) => o.store_id === s1.id);
        assert.equal(
          (
            await request(
              "PATCH",
              `/seller/orders/${order.id}/status`,
              { status: "completed" },
              seller.access_token,
            )
          ).status,
          409,
        );
        for (const status of ["processing", "ready", "completed"])
          assert.equal(
            (
              await request(
                "PATCH",
                `/seller/orders/${order.id}/status`,
                { status },
                seller.access_token,
              )
            ).status,
            200,
          );
        assert.equal(
          (await db("order_status_history").where({ order_id: order.id }))
            .length,
          5,
        );
        const f = await db("fulfillments")
          .where({ order_id: order.id })
          .first();
        assert.equal(f.status, "picked_up");
        assert.equal(
          (
            await db("fulfillment_status_history").where({
              fulfillment_id: f.id,
            })
          ).length,
          4,
        );
      },
    );
    await t.test(
      "simultaneous checkout prevents overselling and failure releases stock",
      async () => {
        const rare = await product(s1, "rare", 1);
        await request(
          "POST",
          "/cart/items",
          { variant_id: rare.variant.id, quantity: 1 },
          buyer.access_token,
        );
        await request(
          "POST",
          "/cart/items",
          { variant_id: rare.variant.id, quantity: 1 },
          other.access_token,
        );
        const results = await Promise.all([
          request(
            "POST",
            "/checkouts",
            { address_id: a1.data.id, method: "qris" },
            buyer.access_token,
          ),
          request(
            "POST",
            "/checkouts",
            { address_id: a2.data.id, method: "qris" },
            other.access_token,
          ),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        const winner = results.find((r) => r.status === 200).data;
        const failed = await event(winner.payment, "failed");
        assert.equal(failed.statusCode, 200, failed.body);
        const inv = await db("inventories")
          .where({ variant_id: rare.variant.id })
          .first();
        assert.equal(inv.reserved, 0);
        assert.equal(inv.on_hand, 1);
        assert.equal(
          (
            await db("inventory_movements").where({
              variant_id: rare.variant.id,
              type: "release",
            })
          ).length,
          1,
        );
      },
    );
    await t.test(
      "refund is persisted, idempotent, audited, and operational role cannot refund",
      async () => {
        const order = checkout.orders[0];
        assert.equal(
          (
            await request(
              "POST",
              `/super-admin/orders/${order.id}/refund`,
              { reason: "Test refund" },
              admin.access_token,
            )
          ).status,
          403,
        );
        const result = await request(
          "POST",
          `/super-admin/orders/${order.id}/refund`,
          { reason: "Test refund" },
          superAdmin.access_token,
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.data.status, "success");
        assert.equal(
          (
            await request(
              "POST",
              `/super-admin/orders/${order.id}/refund`,
              { reason: "Retry" },
              superAdmin.access_token,
            )
          ).status,
          200,
        );
        assert.equal(
          (await db("refunds").where({ order_id: order.id })).length,
          1,
        );
        assert.ok(
          (await db("audit_logs").where({ action: "refund.result" })).length,
        );
        await assert.rejects(
          db("audit_logs").update({ reason: "tampering" }),
          /append-only/,
        );
      },
    );
    await t.test(
      "seller application approval, product moderation and audit",
      async () => {
        const applied = await request(
          "POST",
          "/seller/applications",
          {
            proposed_store_name: "New shop",
            business_description: "A local shop",
            business_category_id: category.id,
          },
          other.access_token,
        );
        assert.equal(applied.status, 200, JSON.stringify(applied));
        const approved = await request(
          "POST",
          `/admin/applications/${applied.data.id}/review`,
          { approve: true, reason: "Verified application" },
          admin.access_token,
        );
        assert.equal(approved.status, 200, JSON.stringify(approved));
        assert.equal(approved.data.store.status, "draft");
        assert.ok(
          await db("store_members")
            .where({
              store_id: approved.data.store.id,
              user_id: other.user.id,
              role: "owner",
            })
            .first(),
        );
        const mod = await request(
          "PATCH",
          `/admin/products/${p2.id}`,
          { status: "rejected", reason: "Policy review" },
          admin.access_token,
        );
        assert.equal(mod.status, 200);
        assert.equal(
          (await request("GET", `/products/by-slug/${p2.slug}`)).status,
          404,
        );
        assert.equal(
          (await db("moderation_actions").where({ target_id: p2.id })).length,
          1,
        );
      },
    );
    await t.test(
      "expiry worker releases reservations without a browser callback",
      async () => {
        const fresh = await register("expiry");
        const addr = await request(
          "POST",
          "/addresses",
          addressData,
          fresh.access_token,
        );
        await request(
          "POST",
          "/cart/items",
          { variant_id: p1.variant.id, quantity: 1 },
          fresh.access_token,
        );
        const result = await request(
          "POST",
          "/checkouts",
          { address_id: addr.data.id, method: "qris" },
          fresh.access_token,
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        await db("payments")
          .where({ id: result.data.payment.id })
          .update({ expires_at: new Date(0) });
        await commerceRepository(db, config).expire();
        assert.equal(
          (await db("checkouts").where({ id: result.data.id }).first()).status,
          "expired",
        );
      },
    );
    await t.test(
      "cart quote reserves nothing; a late transaction failure rolls back all records",
      async () => {
        const fresh = await register("rollback");
        const addr = await request(
          "POST",
          "/addresses",
          addressData,
          fresh.access_token,
        );
        await request(
          "POST",
          "/cart/items",
          { variant_id: p1.variant.id, quantity: 1 },
          fresh.access_token,
        );
        const before = await db("inventories")
          .where({ variant_id: p1.variant.id })
          .first();
        const quote = await request(
          "POST",
          "/cart/quote",
          { method: "qris" },
          fresh.access_token,
        );
        assert.equal(quote.status, 200, JSON.stringify(quote));
        assert.equal(quote.data.grand_total, "21500");
        const counts = await Promise.all(
          [
            "checkouts",
            "orders",
            "order_items",
            "order_addresses",
            "order_fees",
            "fulfillments",
            "inventory_movements",
          ].map(async (table) => [
            table,
            Number((await db(table).count("* as n").first()).n),
          ]),
        );
        await assert.rejects(
          commerceRepository(db, {
            ...config,
            provider: "x".repeat(51),
          }).checkout(fresh.user.id, {
            address_id: addr.data.id,
            fulfillment: {},
            method: "qris",
          }),
        );
        for (const [table, n] of counts)
          assert.equal(
            Number((await db(table).count("* as n").first()).n),
            n,
            table,
          );
        assert.equal(
          (await db("inventories").where({ id: before.id }).first()).reserved,
          before.reserved,
        );
        assert.ok(
          await db("carts")
            .where({ user_id: fresh.user.id, status: "active" })
            .first(),
        );
      },
    );
    await t.test(
      "seller product creation, price/stock update, role revocation and notifications",
      async () => {
        const created = await request(
          "POST",
          `/seller/stores/${s1.id}/products`,
          {
            name: "Bag",
            description: "Canvas bag",
            category_id: category.id,
            condition: "new",
            variants: [{ name: "Default", price: "50000", on_hand: 3 }],
            media: [{ url: "https://example.test/bag.png" }],
            tags: ["bag", "canvas"],
          },
          seller.access_token,
        );
        assert.equal(created.status, 200, JSON.stringify(created));
        assert.equal(
          (await request("GET", `/products/by-slug/${created.data.slug}`))
            .status,
          404,
        );
        await request(
          "PATCH",
          `/admin/products/${created.data.id}`,
          { status: "approved", reason: "Listing verified" },
          admin.access_token,
        );
        const published = await request(
          "GET",
          `/products/by-slug/${created.data.slug}`,
        );
        assert.equal(published.status, 200, JSON.stringify(published));
        assert.deepEqual(published.data.tags.sort(), ["bag", "canvas"]);
        const variant = published.data.variants[0];
        const updated = await request(
          "PATCH",
          `/seller/variants/${variant.id}`,
          { price: "55000", on_hand: 5 },
          seller.access_token,
        );
        assert.equal(updated.status, 200, JSON.stringify(updated));
        assert.equal(
          (await db("products").where({ id: created.data.id }).first())
            .min_price,
          "55000",
        );
        await request(
          "PUT",
          `/favorites/${created.data.id}`,
          null,
          buyer.access_token,
        );
        assert.equal(
          (await request("GET", "/favorites", null, buyer.access_token)).data
            .length,
          1,
        );
        await db("store_members")
          .where({ store_id: s1.id, user_id: seller.user.id })
          .update({ status: "inactive" });
        assert.equal(
          (
            await request(
              "PATCH",
              `/seller/variants/${variant.id}`,
              { price: "1" },
              seller.access_token,
            )
          ).status,
          404,
        );
        await db("store_members")
          .where({ store_id: s1.id, user_id: seller.user.id })
          .update({ status: "active" });
        const notes = await request(
          "GET",
          "/notifications",
          null,
          buyer.access_token,
        );
        assert.ok(notes.data.length);
        assert.equal(
          (
            await request(
              "PUT",
              `/notifications/${notes.data[0].id}/read`,
              null,
              other.access_token,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await request(
              "PUT",
              `/notifications/${notes.data[0].id}/read`,
              null,
              buyer.access_token,
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "payment mismatch cannot mutate stock; whole-payment refund retry is idempotent",
      async () => {
        const bad = await event(
          { ...checkout.payment, amount: "1" },
          "success",
        );
        assert.equal(bad.statusCode, 400);
        const remaining = checkout.orders[1];
        const result = await request(
          "POST",
          `/super-admin/orders/${remaining.id}/refund`,
          { reason: "Remaining order refund" },
          superAdmin.access_token,
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(
          (await db("payments").where({ id: checkout.payment.id }).first())
            .status,
          "refunded",
        );
        const retry = await request(
          "POST",
          `/super-admin/orders/${remaining.id}/refund`,
          { reason: "Retry" },
          superAdmin.access_token,
        );
        assert.equal(retry.status, 200, JSON.stringify(retry));
        assert.equal(
          (await db("refunds").where({ order_id: remaining.id })).length,
          1,
        );
      },
    );
    await t.test(
      "controlled admin creation, access revocation, fee snapshot retention and CORS",
      async () => {
        const created = await request(
          "POST",
          "/super-admin/admins",
          {
            name: "Operator",
            email: "operator@example.test",
            password: "Test-only-password-123!",
            reason: "Hire operator",
          },
          superAdmin.access_token,
        );
        assert.equal(created.status, 200, JSON.stringify(created));
        const login = await request("POST", "/auth/login", {
          email: "operator@example.test",
          password: "Test-only-password-123!",
        });
        assert.deepEqual(login.data.user.roles, ["admin"]);
        const disabled = await request(
          "PATCH",
          `/super-admin/admins/${created.data.id}`,
          { action: "disable", reason: "Disable operator" },
          superAdmin.access_token,
        );
        assert.equal(disabled.status, 200, JSON.stringify(disabled));
        assert.equal(
          (await request("GET", "/admin/orders", null, login.data.access_token))
            .status,
          401,
        );
        const fee = await request(
          "POST",
          "/super-admin/fee-rules",
          {
            name: "Future fee",
            percentage: "1.5000",
            fixed_amount: "0",
            scope_type: "store",
            scope_id: s1.id,
            effective_from: "2027-01-01T00:00:00Z",
            status: "scheduled",
            reason: "Planned pricing",
          },
          superAdmin.access_token,
        );
        assert.equal(fee.status, 200, JSON.stringify(fee));
        const saved = await db("order_fees").whereIn(
          "order_id",
          checkout.orders.map((o) => o.id),
        );
        assert.ok(saved.every((f) => f.percentage_snapshot === "3.0000"));
        assert.equal(
          (
            await app.inject({
              url: "/health",
              headers: { origin: "https://untrusted.example" },
            })
          ).statusCode,
          403,
        );
      },
    );
    await t.test('real frontend API layer: auth refresh, buyer checkout, seller and admin contracts', async () => {
      let forceExpired = false, refreshCalls = 0;
      const tokens = new Map();
      const storage = { getItem: key => tokens.get(key), setItem: (key, value) => tokens.set(key, value), removeItem: key => tokens.delete(key) };
      const fetchImpl = async (url, options) => {
        const headers = { ...options.headers, origin: 'http://localhost:5173' };
        if (forceExpired && url.endsWith('/users/me')) { headers.Authorization = 'Bearer expired'; forceExpired = false; }
        if (url.endsWith('/auth/refresh')) refreshCalls++;
        const res = await app.inject({ method: options.method, url, headers, payload: options.body });
        return new Response(res.body, { status: res.statusCode });
      };
      const client = createApi({ fetchImpl, storage });
      const user = await client.authenticate(true, { name: 'Browser flow', email: 'browser@example.test', password: 'Test-only-password-123!' });
      assert.deepEqual(user.roles, ['buyer']);
      forceExpired = true;
      assert.equal((await client.request('/users/me')).id, user.id);
      assert.equal(refreshCalls, 1);
      const [cat] = await db('categories').insert({ name: 'Browser catalog', slug: 'browser-catalog' }).returning('*');
      const store = await newStore('browser-store');
      const item = await product(store, 'browser-product', 8, '12000');
      await db('products').where({ id: item.id }).update({ category_id: cat.id });
      await db('stores').where({ id: store.id }).update({ primary_category_id: cat.id });
      const detail = await client.request(`/products/by-slug/${item.slug}`, { auth: false });
      assert.equal(detail.variants[0].id, item.variant.id);
      assert.equal(typeof detail.variants[0].price, 'string');
      assert.ok((await client.request('/search?q=browser&type=store', { auth: false })).some(s => s.id === store.id));
      await client.request(`/favorites/${item.id}`, { method: 'PUT' });
      assert.equal((await client.request('/favorites'))[0].id, item.id);
      const address = await client.request('/addresses', { method: 'POST', body: addressData });
      await client.request('/cart/items', { method: 'POST', body: { variant_id: item.variant.id, quantity: 2 } });
      const cart = await client.request('/cart');
      assert.equal(cart.items[0].quantity, 2);
      const body = { method: 'qris', fulfillment: { [store.id]: 'pickup' }, address_id: address.id };
      const quote = await client.request('/cart/quote', { method: 'POST', body });
      const checkout = await client.request('/checkouts', { method: 'POST', body });
      assert.equal(checkout.grand_total, quote.grand_total);
      const payment = await client.request(`/payments/${checkout.payment.id}`);
      assert.equal(payment.status, 'pending');
      assert.ok((await client.request(`/payments/${payment.id}/session`, { method: 'POST' })).provider_reference);
      const paid = await event(checkout.payment, 'success');
      assert.equal(paid.statusCode, 200);
      const orders = await client.request('/orders');
      assert.equal(orders[0].status, 'confirmed');
      assert.equal(orders[0].items[0].product_name, item.name);
      assert.equal(orders[0].payment.id, undefined, 'Buyer order intentionally does not expose payment ID');
      assert.ok((await client.request('/notifications')).length);
      await client.request('/reports', { method: 'POST', body: { target_type: 'order', target_id: orders[0].id, category: 'delivery', description: 'Browser report test' } });
      await grant({ user }, 'seller');
      await db('store_members').insert({ store_id: store.id, user_id: user.id, role: 'owner' });
      assert.ok((await client.request('/users/me')).roles.includes('seller'));
      const owned = await client.request(`/seller/stores/${store.id}/products`);
      assert.equal(owned[0].variants, undefined, 'Seller list has no variant detail contract');
      await client.request(`/seller/orders/${orders[0].id}/status`, { method: 'PATCH', body: { status: 'processing' } });
      await assert.rejects(client.request('/admin/orders'), { status: 403 });
      const privileged = createApi({ fetchImpl });
      await privileged.authenticate(false, { email: 'super@example.test', password: 'Test-only-password-123!' });
      assert.ok((await privileged.request('/super-admin/transactions')).some(o => o.id === orders[0].id));
      const restored = createApi({ fetchImpl, storage });
      assert.equal((await restored.restore()).id, user.id);
      await restored.logout();
      assert.equal(await restored.restore(), null);
      await privileged.logout();
    });
    await t.test("category master: RBAC, validation, rename, status and safe delete", async () => {
      // Separate client address so this subtest has its own rate-limit budget.
      const request = async (method, path, body, token) => {
        const response = await app.inject({
          method,
          url: `/api/v1${path}`,
          payload: body,
          remoteAddress: "198.51.100.7",
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        return { status: response.statusCode, ...response.json() };
      };
      const register = async (name) => {
        const r = await request("POST", "/auth/register", {
          name,
          email: `${name}@example.test`,
          password: "Test-only-password-123!",
        });
        assert.equal(r.status, 201, JSON.stringify(r));
        return r.data;
      };
      const catAdmin = await register("cat-admin"),
        catSuper = await register("cat-super"),
        catBuyer = await register("cat-buyer"),
        catSeller = await register("cat-seller");
      await grant(catAdmin, "admin");
      await grant(catSuper, "super_admin");
      await grant(catSeller, "seller");
      const adminToken = catAdmin.access_token,
        superToken = catSuper.access_token;

      // C. Unauthorized roles are rejected by the server, not only hidden in the UI.
      for (const token of [catBuyer.access_token, catSeller.access_token]) {
        assert.equal((await request("GET", "/admin/categories", undefined, token)).status, 403);
        const denied = await request("POST", "/admin/categories", { name: "Forbidden" }, token);
        assert.equal(denied.status, 403);
        assert.equal(denied.error.code, "FORBIDDEN");
        assert.equal((await request("PATCH", `/admin/categories/${category.id}`, { name: "Hijack" }, token)).status, 403);
        assert.equal((await request("DELETE", `/admin/categories/${category.id}`, undefined, token)).status, 403);
      }
      assert.equal((await request("POST", "/admin/categories", { name: "Anon" })).status, 401);
      assert.ok(!(await db("categories").whereIn("name", ["Forbidden", "Anon"]).first()));

      // A. Admin creates; whitespace is normalized.
      const created = await request("POST", "/admin/categories", { name: "  Kuliner   Lokal " }, adminToken);
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.equal(created.data.name, "Kuliner Lokal");
      assert.equal(created.data.slug, "kuliner-lokal");
      assert.equal(created.data.status, "active");
      assert.ok((await request("GET", "/categories")).data.some((c) => c.id === created.data.id));

      // E. Validation and case-insensitive duplicates (existing "Fashion").
      for (const name of ["", "   "])
        assert.equal((await request("POST", "/admin/categories", { name }, adminToken)).error.code, "VALIDATION_ERROR");
      assert.equal((await request("POST", "/admin/categories", {}, adminToken)).status, 400);
      for (const name of ["Fashion", "fashion", " FASHION ", "kuliner lokal"]) {
        const dup = await request("POST", "/admin/categories", { name }, superToken);
        assert.equal(dup.status, 409, name);
        assert.equal(dup.error.code, "CATEGORY_NAME_TAKEN");
      }
      assert.equal(
        (await request("PATCH", `/admin/categories/${created.data.id}`, { name: "FASHION" }, adminToken)).error.code,
        "CATEGORY_NAME_TAKEN",
      );
      assert.equal((await request("PATCH", `/admin/categories/${created.data.id}`, {}, adminToken)).status, 400);
      await assert.rejects(
        db("categories").insert({ name: "fashion ", slug: "raw-dup" }),
        /uq_categories_name_ci/,
      );

      // B. Super admin renames; the public list returns the latest name and the slug stays stable.
      const renamed = await request("PATCH", `/admin/categories/${created.data.id}`, { name: "Kuliner & Minuman" }, superToken);
      assert.equal(renamed.status, 200, JSON.stringify(renamed));
      assert.equal(renamed.data.name, "Kuliner & Minuman");
      assert.equal(renamed.data.slug, "kuliner-lokal");
      assert.equal((await request("GET", "/categories")).data.find((c) => c.id === created.data.id).name, "Kuliner & Minuman");
      // Case-only rename of the same category is allowed.
      assert.equal((await request("PATCH", `/admin/categories/${created.data.id}`, { name: "kuliner & minuman" }, adminToken)).status, 200);

      // D. Seller application stores the category ID and is visible with its name.
      const applied = await request(
        "POST",
        "/seller/applications",
        { proposed_store_name: "Warung Cat", business_description: "Makanan", business_category_id: created.data.id },
        catBuyer.access_token,
      );
      assert.equal(applied.status, 200, JSON.stringify(applied));
      const mine = await request("GET", "/seller/applications", undefined, catBuyer.access_token);
      assert.equal(mine.data[0].business_category_id, created.data.id);
      assert.equal(mine.data[0].business_category_name, "kuliner & minuman");
      assert.ok(
        (await request("GET", "/admin/applications", undefined, adminToken)).data.some(
          (a) => a.id === applied.data.id && a.business_category_name === "kuliner & minuman",
        ),
      );

      // Deactivate: hidden from sellers, new applications rejected, still listed for admins.
      const off = await request("PATCH", `/admin/categories/${created.data.id}`, { status: "inactive" }, adminToken);
      assert.equal(off.data.status, "inactive");
      assert.ok(!(await request("GET", "/categories")).data.some((c) => c.id === created.data.id));
      const rejected = await request(
        "POST",
        "/seller/applications",
        { proposed_store_name: "Late", business_description: "x", business_category_id: created.data.id },
        catSeller.access_token,
      );
      assert.equal(rejected.error.code, "CATEGORY_UNAVAILABLE");
      const listed = (await request("GET", "/admin/categories", undefined, superToken)).data.find((c) => c.id === created.data.id);
      assert.equal(listed.status, "inactive");
      assert.equal(listed.usage_count, 1);
      // Legacy moderation payload {status, reason} remains valid.
      assert.equal((await request("PATCH", `/admin/categories/${created.data.id}`, { status: "active", reason: "Reopen" }, adminToken)).data.status, "active");
      assert.ok(await db("moderation_actions").where({ target_type: "categories", target_id: created.data.id }).first());

      // F. Referenced categories cannot be deleted and related data is untouched.
      for (const id of [created.data.id, category.id]) {
        const blocked = await request("DELETE", `/admin/categories/${id}`, undefined, adminToken);
        assert.equal(blocked.status, 409);
        assert.equal(blocked.error.code, "CATEGORY_IN_USE");
      }
      assert.equal((await db("seller_applications").where({ id: applied.data.id }).first()).business_category_id, created.data.id);
      assert.equal((await db("stores").where({ id: s1.id }).first()).primary_category_id, category.id);
      assert.equal((await db("products").where({ id: p1.id }).first()).category_id, category.id);
      assert.equal((await db("categories").where({ id: category.id }).first()).deleted_at, null);

      // Unreferenced categories are soft-deleted; the name becomes reusable.
      const temp = await request("POST", "/admin/categories", { name: "Sementara" }, superToken);
      const removed = await request("DELETE", `/admin/categories/${temp.data.id}`, undefined, superToken);
      assert.deepEqual(removed.data, { id: temp.data.id, deleted: true });
      assert.ok((await db("categories").where({ id: temp.data.id }).first()).deleted_at);
      assert.ok(!(await request("GET", "/admin/categories", undefined, adminToken)).data.some((c) => c.id === temp.data.id));
      assert.equal((await request("DELETE", `/admin/categories/${temp.data.id}`, undefined, adminToken)).status, 404);
      assert.equal((await request("PATCH", `/admin/categories/${temp.data.id}`, { name: "Zombie" }, adminToken)).status, 404);
      const reused = await request("POST", "/admin/categories", { name: "sementara" }, adminToken);
      assert.equal(reused.status, 201);
      assert.notEqual(reused.data.slug, "sementara");
      assert.ok(await db("audit_logs").where({ action: "categories.delete", entity_id: temp.data.id }).first());
    });
    assert.equal((await app.inject("/health")).statusCode, 200);
  } finally {
    if (app) await app.close();
    await db.destroy();
  }
});

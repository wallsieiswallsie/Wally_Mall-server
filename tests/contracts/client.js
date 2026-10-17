import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
export async function clientContract({
  t,
  app,
  db,
  newStore,
  product,
  addressData,
  event,
  grant,
}) {
  const { createApi } = await import(
    pathToFileURL(process.env.CLIENT_API_MODULE).href
  );
  await t.test(
    "real frontend API layer: auth refresh, buyer checkout, seller and admin contracts",
    async () => {
      let forceExpired = false,
        refreshCalls = 0;
      const tokens = new Map();
      const storage = {
        getItem: (key) => tokens.get(key),
        setItem: (key, value) => tokens.set(key, value),
        removeItem: (key) => tokens.delete(key),
      };
      const fetchImpl = async (url, options) => {
        const headers = { ...options.headers, origin: "http://localhost:5173" };
        if (forceExpired && url.endsWith("/users/me")) {
          headers.Authorization = "Bearer expired";
          forceExpired = false;
        }
        if (url.endsWith("/auth/refresh")) refreshCalls++;
        const res = await app.inject({
          method: options.method,
          url,
          headers,
          payload: options.body,
        });
        return new Response(res.body, { status: res.statusCode });
      };
      const client = createApi({ fetchImpl, storage });
      const user = await client.authenticate(true, {
        name: "Browser flow",
        email: "browser@example.test",
        password: "Test-only-password-123!",
      });
      assert.deepEqual(user.roles, ["buyer"]);
      forceExpired = true;
      assert.equal((await client.request("/users/me")).id, user.id);
      assert.equal(refreshCalls, 1);
      const [cat] = await db("categories")
        .insert({ name: "Browser catalog", slug: "browser-catalog" })
        .returning("*");
      const store = await newStore("browser-store");
      const item = await product(store, "browser-product", 8, "12000");
      await db("products")
        .where({ id: item.id })
        .update({ category_id: cat.id });
      await db("stores")
        .where({ id: store.id })
        .update({ primary_category_id: cat.id });
      const detail = await client.request(`/products/by-slug/${item.slug}`, {
        auth: false,
      });
      assert.equal(detail.variants[0].id, item.variant.id);
      assert.equal(typeof detail.variants[0].price, "string");
      assert.ok(
        (
          await client.request("/search?q=browser&type=store", { auth: false })
        ).some((s) => s.id === store.id),
      );
      await client.request(`/favorites/${item.id}`, { method: "PUT" });
      assert.equal((await client.request("/favorites"))[0].id, item.id);
      const address = await client.request("/addresses", {
        method: "POST",
        body: addressData,
      });
      await client.request("/cart/items", {
        method: "POST",
        body: { variant_id: item.variant.id, quantity: 2 },
      });
      const cart = await client.request("/cart");
      assert.equal(cart.items[0].quantity, 2);
      const body = {
        method: "qris",
        fulfillment: { [store.id]: "pickup" },
        address_id: address.id,
      };
      const quote = await client.request("/cart/quote", {
        method: "POST",
        body,
      });
      const checkout = await client.request("/checkouts", {
        method: "POST",
        body,
      });
      assert.equal(checkout.grand_total, quote.grand_total);
      // No checkout/payment mapping is saved; a fresh API instance recovers from orders.
      const resumed = createApi({ fetchImpl, storage });
      await resumed.restore();
      const recovered = (await resumed.request("/orders"))[0].payment;
      assert.equal(recovered.id, checkout.payment.id);
      const firstSession = await resumed.request(
        `/payments/${recovered.id}/session`,
        { method: "POST" },
      );
      const nextSession = await resumed.request(
        `/payments/${recovered.id}/session`,
        { method: "POST" },
      );
      assert.equal(
        firstSession.provider_reference,
        nextSession.provider_reference,
      );
      assert.equal(
        (await db("payments").where({ checkout_id: checkout.id })).length,
        1,
      );
      const payment = await client.request(`/payments/${recovered.id}`);
      assert.equal(payment.status, "pending");
      assert.ok(
        (
          await client.request(`/payments/${payment.id}/session`, {
            method: "POST",
          })
        ).provider_reference,
      );
      const paid = await event(checkout.payment, "success");
      assert.equal(paid.statusCode, 200);
      const orders = await client.request("/orders");
      assert.equal(orders[0].status, "confirmed");
      assert.equal(orders[0].items[0].product_name, item.name);
      assert.equal(orders[0].payment.id, payment.id);
      assert.ok((await client.request("/notifications")).length);
      await client.request("/reports", {
        method: "POST",
        body: {
          target_type: "order",
          target_id: orders[0].id,
          category: "delivery",
          description: "Browser report test",
        },
      });
      await grant({ user }, "seller");
      await db("store_members").insert({
        store_id: store.id,
        user_id: user.id,
        role: "owner",
      });
      assert.ok((await client.request("/users/me")).roles.includes("seller"));
      const owned = await client.request(`/seller/stores/${store.id}/products`);
      assert.equal(
        owned[0].variants,
        undefined,
        "Seller list has no variant detail contract",
      );
      await client.request(`/seller/orders/${orders[0].id}/status`, {
        method: "PATCH",
        body: { status: "processing" },
      });
      await assert.rejects(client.request("/admin/orders"), { status: 403 });
      const privileged = createApi({ fetchImpl });
      await privileged.authenticate(false, {
        email: "super@example.test",
        password: "Test-only-password-123!",
      });
      assert.ok(
        (await privileged.request("/super-admin/transactions")).some(
          (o) => o.id === orders[0].id,
        ),
      );
      const restored = createApi({ fetchImpl, storage });
      assert.equal((await restored.restore()).id, user.id);
      await restored.logout();
      assert.equal(await restored.restore(), null);
      await privileged.logout();
    },
  );
}

import assert from "node:assert/strict";
export async function recoveryScenarios({
  t,
  app,
  db,
  seller,
  outsider,
  buyer,
  product,
  newStore,
}) {
  const request = async (method, path, body, token = seller.access_token) => {
    const res = await app.inject({
      method,
      url: `/api/v1${path}`,
      payload: body,
      remoteAddress: "198.51.100.80",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.statusCode, ...res.json() };
  };
  await t.test(
    "seller restock: invisible products, membership, staff capability and restrictions",
    async () => {
      const store = await newStore("restock-store");
      const p = await product(store, "empty-product", 0);
      const detail = () => request("GET", `/seller/products/${p.id}`);
      assert.equal(
        (await request("GET", `/products/by-slug/${p.slug}`)).status,
        404,
      );
      assert.equal((await detail()).data.variants[0].on_hand, 0);
      assert.equal(
        (
          await request(
            "GET",
            `/seller/products/${p.id}`,
            null,
            outsider.access_token,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "GET",
            `/seller/products/${p.id}`,
            null,
            buyer.access_token,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            "PATCH",
            `/seller/variants/${p.variant.id}`,
            { on_hand: 5 },
            outsider.access_token,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request("PATCH", `/seller/variants/${p.variant.id}`, {
            on_hand: 5,
          })
        ).status,
        200,
      );
      for (const status of ["hidden", "draft"]) {
        await db("products")
          .where({ id: p.id })
          .update({ status, moderation_status: "pending" });
        assert.equal((await detail()).data.status, status);
        assert.equal(
          (await request("GET", `/products/by-slug/${p.slug}`)).status,
          404,
        );
        assert.equal(
          (
            await request("PATCH", `/seller/variants/${p.variant.id}`, {
              on_hand: 6,
            })
          ).status,
          200,
        );
      }
      await db("inventories")
        .where({ variant_id: p.variant.id })
        .update({ reserved: 2 });
      const v = (await detail()).data.variants[0];
      assert.equal(v.reserved, 2);
      assert.equal(v.available, 4);
      assert.equal(
        (await request("PATCH", `/seller/variants/${v.id}`, { on_hand: 1 }))
          .error.code,
        "INVALID_INVENTORY",
      );
      await db("store_members")
        .where({ store_id: store.id })
        .update({ role: "staff" });
      assert.equal((await detail()).status, 200);
      assert.equal(
        (await request("PATCH", `/seller/variants/${v.id}`, { on_hand: 9 }))
          .status,
        404,
      );
      await db("store_members")
        .where({ store_id: store.id })
        .update({ role: "manager" });
      assert.equal(
        (await request("PATCH", `/seller/variants/${v.id}`, { on_hand: 9 }))
          .status,
        200,
      );
      await db("stores")
        .where({ id: store.id })
        .update({ status: "suspended" });
      assert.equal(
        (await request("PATCH", `/seller/variants/${v.id}`, { on_hand: 10 }))
          .error.code,
        "STORE_OR_PRODUCT_RESTRICTED",
      );
      assert.equal(
        (
          await request("PATCH", `/seller/products/${p.id}`, {
            name: "blocked",
          })
        ).error.code,
        "STORE_RESTRICTED",
      );
      await db("stores").where({ id: store.id }).update({ status: "active" });
      await db("products").where({ id: p.id }).update({ status: "suspended" });
      assert.equal(
        (await request("PATCH", `/seller/variants/${v.id}`, { on_hand: 10 }))
          .error.code,
        "STORE_OR_PRODUCT_RESTRICTED",
      );
    },
  );
  await t.test(
    "readiness rejects pending migrations and missing schema despite working connection",
    async () => {
      assert.equal((await app.inject("/ready")).statusCode, 200);
      const name = "20261007121411_012_media_assets.js";
      await db.migrate.down({ name });
      assert.equal((await app.inject("/health")).statusCode, 200);
      assert.equal((await app.inject("/ready")).statusCode, 503);
      await db.migrate.latest();
      await db.schema.alterTable("product_media", (table) =>
        table.renameColumn("media_asset_id", "test_missing_asset"),
      );
      const res = await app.inject("/ready");
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { status: "not_ready" });
      await db.schema.alterTable("product_media", (table) =>
        table.renameColumn("test_missing_asset", "media_asset_id"),
      );
      assert.equal((await app.inject("/ready")).statusCode, 200);
    },
  );
}

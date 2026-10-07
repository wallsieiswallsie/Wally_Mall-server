import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { configFromEnv } from "../src/config.js";

test("critical production routes are registered with the canonical API prefix", async (t) => {
  const config = configFromEnv({
    ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
    PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  });
  const db = () => { throw new Error("No database query expected"); };
  db.raw = async () => [{ result: 1 }];
  const app = await buildApp({ db, config, storage: {} });
  t.after(() => app.close());
  await app.ready();
  for (const [method, url] of [
    ["GET", "/health"], ["GET", "/ready"],
    ["POST", "/api/v1/auth/login"], ["GET", "/api/v1/products"],
    ["POST", "/api/v1/media/uploads"],
    ["POST", "/api/v1/media/uploads/:id/complete"],
  ]) assert.equal(app.hasRoute({ method, url }), true, `${method} ${url}`);
  assert.equal(app.hasRoute({ method: "POST", url: "/v1/media/uploads" }), false);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/media/uploads" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/v1/media/uploads" })).statusCode, 404);
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/ready")).statusCode, 200);
});

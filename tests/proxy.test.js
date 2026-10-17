import test from "node:test";
import assert from "node:assert/strict";
import { trustedProxiesFromEnv, configFromEnv } from "../src/config.js";
import { buildApp } from "../src/app.js";
test("proxy trust is explicit and ignores spoofed forwarding from untrusted peers", async (t) => {
  assert.equal(trustedProxiesFromEnv({}), false);
  for (const value of ["true", "*", "0.0.0.0/0", "::/0", "10.0.0.1/33"])
    assert.throws(() => trustedProxiesFromEnv({ TRUSTED_PROXY_CIDRS: value }));
  const config = configFromEnv({
    ACCESS_TOKEN_SECRET: "a".repeat(40),
    PAYMENT_WEBHOOK_SECRET: "b".repeat(40),
    TRUSTED_PROXY_CIDRS: "192.0.2.1/32",
  });
  const app = await buildApp({ config, db: {}, storage: {} });
  t.after(() => app.close());
  app.get("/test-ip", (req) => ({ ip: req.ip }));
  const headers = { "x-forwarded-for": "198.51.100.9" };
  assert.equal(
    (
      await app.inject({
        url: "/test-ip",
        remoteAddress: "203.0.113.1",
        headers,
      })
    ).json().ip,
    "203.0.113.1",
  );
  assert.equal(
    (
      await app.inject({ url: "/test-ip", remoteAddress: "192.0.2.1", headers })
    ).json().ip,
    "198.51.100.9",
  );
});

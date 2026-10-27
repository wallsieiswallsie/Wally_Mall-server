import test from "node:test";
import assert from "node:assert/strict";
import { configFromEnv } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { paymentAdapter } from "../src/payment.js";
test("unsupported provider fails config and app startup, including injected adapter", async () => {
  const env = {
    ACCESS_TOKEN_SECRET: "a".repeat(40),
    PAYMENT_WEBHOOK_SECRET: "b".repeat(40),
  };
  for (const provider of ["midtrans", "", "MOCK"]) {
    assert.throws(
      () => configFromEnv({ ...env, PAYMENT_PROVIDER: provider }),
      /Unsupported PAYMENT_PROVIDER/,
    );
    await assert.rejects(
      buildApp({ db: {}, config: { provider }, storage: {} }),
      /Unsupported PAYMENT_PROVIDER/,
    );
  }
  const config = configFromEnv(env);
  assert.equal(paymentAdapter(config).provider, "mock");
  await assert.rejects(
    buildApp({ db: {}, config, adapter: { provider: "other" }, storage: {} }),
    /mismatch/,
  );
});

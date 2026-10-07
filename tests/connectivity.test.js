import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { configFromEnv } from "../src/config.js";

const origin = "https://wallymall-client-production.up.railway.app";
const env = {
  NODE_ENV: "production",
  PAYMENT_PROVIDER: "mock",
  ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
  PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  CORS_ORIGINS: ` ${origin} , http://localhost:5173 `,
};

test("production config reaches CORS; dependency failures remain private and diagnosable", async (t) => {
  const config = configFromEnv(env);
  assert.equal(config.provider, "mock");
  assert.deepEqual(config.origins, [origin, "http://localhost:5173"]);
  let failure;
  const db = () => {
    throw failure;
  };
  db.raw = async () => {
    if (failure) throw failure;
  };
  const app = await buildApp({ db, config });
  t.after(() => app.close());
  const logs = [];
  app.addHook("onRequest", async (req) => {
    req.log.error = (fields, message) => logs.push({ ...fields, message });
  });

  const health = await app.inject({ url: "/health", headers: { origin } });
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers["access-control-allow-origin"], origin);
  const ready = await app.inject("/ready");
  assert.deepEqual(ready.json(), { status: "ready" });
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/products",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.match(
    preflight.headers["access-control-allow-headers"],
    /authorization/,
  );
  for (const disallowed of ["https://untrusted.example", `${origin}/`]) {
    const response = await app.inject({
      url: "/health",
      headers: { origin: disallowed },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }

  for (const [errorCode, name, expected] of [
    ["ECONNREFUSED", "Error", "ECONNREFUSED"],
    ["42P01", "Error", "42P01"],
    [undefined, "KnexTimeoutError", "DATABASE_TIMEOUT"],
    ["private-error-content", "Error", "INTERNAL_ERROR"],
  ]) {
    failure = Object.assign(
      new Error("private database query and credential details"),
      { code: errorCode, name },
    );
    const response = await app.inject({
      url: "/ready?token=private-query",
      headers: { origin, authorization: "Bearer private-token" },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    const body = response.json();
    assert.deepEqual(body, {
      error: {
        code: "INTERNAL_ERROR",
        request_id: response.headers["x-request-id"],
      },
    });
    assert.deepEqual(logs.at(-1), {
      request_id: body.error.request_id,
      route: "/ready",
      status: 500,
      error_code: expected,
      message: "Request failed",
    });
    assert.equal((await app.inject("/health")).statusCode, 200);
  }
  for (const url of [
    "/api/v1/categories",
    "/api/v1/products?limit=5",
    "/api/v1/stores?limit=3",
  ]) {
    const response = await app.inject({ url, headers: { origin } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers["access-control-allow-origin"], origin);
    assert.equal(response.json().error.code, "INTERNAL_ERROR");
  }
  assert.ok(!JSON.stringify(logs).includes("private"));
});

test(
  "production startup without HOST binds all interfaces and keeps mock payments",
  { timeout: 20000 },
  async () => {
    const childEnv = {
      ...process.env,
      ...env,
      DATABASE_URL: "postgresql://localhost:1/connectivity_test",
      PORT: "0",
    };
    delete childEnv.HOST;
    const child = spawn(process.execPath, ["src/index.js"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const { port, host } = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Startup timed out")),
          15000,
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
          const match = output.match(
            /Wally Mall listening on (\d+) \(([^)]+)\)/,
          );
          if (match) {
            clearTimeout(timer);
            resolve({ port: Number(match[1]), host: match[2] });
          }
        });
        child.stderr.resume();
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited: ${code}`));
        });
      });
      assert.equal(host, "0.0.0.0");
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: origin },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("access-control-allow-origin"), origin);
      assert.deepEqual(await health.json(), { status: "ok" });
    } finally {
      child.kill();
      if (child.pid && child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once("close", resolve));
    }
  },
);

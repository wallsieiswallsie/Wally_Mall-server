import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
test(
  "real server startup and health/readiness over HTTP",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 },
  async () => {
    const child = spawn(process.execPath, ["src/index.js"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
        PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
        PAYMENT_PROVIDER: "mock",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
          const match = output.match(/listening on (\d+)/);
          if (match) resolve(Number(match[1]));
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`Server exited: ${code}`)),
        );
        child.stderr.on("data", (data) => {
          output += data;
        });
      });
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok" });
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready" });
    } finally {
      child.kill();
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", resolve),
      );
    }
  },
);

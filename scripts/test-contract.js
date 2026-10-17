import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
if (
  !process.env.CLIENT_API_MODULE ||
  !isAbsolute(process.env.CLIENT_API_MODULE) ||
  !process.env.TEST_DATABASE_URL
)
  throw new Error(
    "Set CLIENT_API_MODULE to the absolute client packages/api-client/client.js path and TEST_DATABASE_URL to a new disposable database",
  );
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "tests/integration.test.js"],
  { stdio: "inherit", windowsHide: true },
);
process.exitCode = result.status ?? 1;

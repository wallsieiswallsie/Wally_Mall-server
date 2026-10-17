import { connect } from "../database/index.js";
import { commerceRepository } from "../database/transactions/commerce.js";
import { configFromEnv } from "./config.js";
const db = connect();
try {
  console.log(await commerceRepository(db, configFromEnv()).expire());
} catch {
  console.error("Payment expiry failed; check database and configuration. No credentials logged.");
  process.exitCode = 1;
} finally {
  await db.destroy();
}

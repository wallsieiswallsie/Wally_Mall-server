import { connect } from "../database/index.js";
import { commerceRepository } from "../database/transactions/commerce.js";
import { configFromEnv } from "./config.js";
const db = connect();
try {
  console.log(await commerceRepository(db, configFromEnv()).expire());
} finally {
  await db.destroy();
}

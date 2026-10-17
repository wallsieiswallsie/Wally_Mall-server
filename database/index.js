import knex from "knex";
import config from "./knexfile.js";
import { databaseFromEnv } from "../src/config.js";
export function connect(connection = databaseFromEnv()) {
  if (!connection) throw new Error("DATABASE_URL is required");
  return knex({ ...config, connection });
}
export async function checkConnection(db) {
  await db.raw("select 1");
}

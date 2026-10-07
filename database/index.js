import knex from "knex";
import config from "./knexfile.js";
export function connect(connection = process.env.DATABASE_URL) {
  if (!connection) throw new Error("DATABASE_URL is required");
  return knex({ ...config, connection });
}
export async function checkConnection(db) {
  await db.raw("select 1");
}

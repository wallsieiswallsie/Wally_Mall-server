import { fileURLToPath } from "node:url";
import { databaseFromEnv } from "../src/config.js";
export default {
  client: "pg",
  connection: databaseFromEnv(),
  pool: { min: 0, max: 10 },
  acquireConnectionTimeout: 5000,
  migrations: {
    directory: fileURLToPath(new URL("./migrations", import.meta.url)),
    loadExtensions: [".js"],
  },
  seeds: {
    directory: fileURLToPath(new URL("./seeds", import.meta.url)),
    loadExtensions: [".js"],
  },
};

import { connect } from "../database/index.js";
import { configFromEnv } from "./config.js";
import { buildApp } from "./app.js";
const config = configFromEnv(),
  db = connect();
const app = await buildApp({ db, config });
app.addHook("onClose", () => db.destroy());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
});
const address = app.server.address();
console.log(`Wally Mall listening on ${address.port} (${address.address})`);

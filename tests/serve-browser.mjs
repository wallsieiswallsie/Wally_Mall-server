// Optional browser smoke-test host. Uses ONLY an explicitly selected disposable DB.
// Run integration.test.js first to populate its fixtures; never use application data.
import { randomBytes } from 'node:crypto';
import { connect } from '../database/index.js';
import { buildApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !/test/i.test(new URL(connection).pathname) || connection === process.env.DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a separate disposable test database.');
}
const db = connect(connection);
const app = await buildApp({ db, config: configFromEnv({
  NODE_ENV: 'test', PAYMENT_PROVIDER: 'mock',
  ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'),
  PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173',
}) });
app.addHook('onClose', () => db.destroy());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 3001) });
console.log(`Disposable test API listening on ${app.server.address().port}`);

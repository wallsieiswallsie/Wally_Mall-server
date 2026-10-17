import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, originsFromEnv } from '../src/config.js';

const valid = { NODE_ENV: 'production', ACCESS_TOKEN_SECRET: 'a'.repeat(32), PAYMENT_WEBHOOK_SECRET: 'b'.repeat(32), GCS_BUCKET: 'test-media', CORS_ORIGINS: 'https://buyer.example,https://seller.example,https://admin.example' };
test('production requires explicit CORS and storage; all configured portals are retained', () => {
  assert.deepEqual(configFromEnv(valid).origins, ['https://buyer.example', 'https://seller.example', 'https://admin.example']);
  assert.throws(() => configFromEnv({...valid,CORS_ORIGINS:''}), /CORS_ORIGINS/);
  assert.throws(() => configFromEnv({...valid,GCS_BUCKET:''}), /GCS_BUCKET/);
  for (const CORS_ORIGINS of ['*', 'https://buyer.example/path', 'https://buyer.example/', 'null'])
    assert.throws(() => originsFromEnv({...valid,CORS_ORIGINS}), /CORS_ORIGINS/);
  assert.equal(configFromEnv({...valid, PORT:'8080'}).listen.port, 8080);
  assert.throws(() => configFromEnv({...valid, PORT:'not-a-port'}), /PORT/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { RedisWindowStore } = require('../src/security/rateLimitStore');
test('live Redis: independent workers share atomic sliding window and expiry', { skip: process.env.RUN_REDIS_TESTS !== 'true' }, async () => {
  require('dotenv').config({ quiet: true });
  const { Redis } = require('@upstash/redis');
  const make = () => new RedisWindowStore(new Redis({ url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN, retry: false, signal: () => AbortSignal.timeout(3000) }), true);
  const workers = [make(), make()];
  const key = 'rl:test:' + randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => workers[index % 2].consume(key, { limit: 3, windowMs: 10000 })));
  assert.equal(results.filter(result => result.allowed).length, 3);
  assert.ok(results.every(result => result.remaining >= 0));
  const expiring = key + ':expiry';
  assert.equal((await workers[0].consume(expiring, { limit: 1, windowMs: 200 })).allowed, true);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await workers[1].consume(expiring, { limit: 1, windowMs: 200 })).allowed, true);
});

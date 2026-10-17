const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const policies = require('../src/security/rateLimitPolicies');
const { MemoryWindowStore } = require('../src/security/rateLimitStore');
const { createLimiter, identity } = require('../src/security/rateLimiter');
const request = () => ({ method: 'POST', ip: '192.0.2.1', headers: {}, user: { _id: 'user-1' }, body: { email: 'rider@example.com' } });
async function invoke(limiter, req = request()) {
  const result = { status: 200, headers: {} };
  const res = { setHeader: (key, value) => { result.headers[key] = value; },
    status: code => { result.status = code; return res; }, json: body => { result.body = body; } };
  await limiter(req, res, error => { if (error) throw error; });
  return result;
}
for (const [name, policy] of Object.entries(policies)) {
  test(name + ': exact limit, headers, expiry and concurrent workers', async () => {
    let now = 0;
    const store = new MemoryWindowStore(() => now);
    const first = createLimiter(name, { store });
    const second = createLimiter(name, { store });
    const results = await Promise.all(Array.from({ length: policy.limit + 1 }, (_, index) => invoke(index % 2 ? first : second)));
    assert.equal(results.filter(result => result.status === 200).length, policy.limit);
    const rejected = results.find(result => result.status === 429);
    assert.equal(rejected.body.code, 'RATE_LIMITED');
    assert.equal(rejected.headers['RateLimit-Remaining'], 0);
    assert.equal(rejected.headers['Retry-After'], policy.windowMs / 1000);
    now = policy.windowMs - 1;
    assert.equal((await invoke(first)).status, 429);
    now++;
    assert.equal((await invoke(second)).status, 200);
  });
}
test('NAT users, normalized accounts, IPv6 and trusted IP inputs', async () => {
  const one = request(), two = request();
  two.user._id = 'user-2';
  assert.notEqual(identity(one, 'user'), identity(two, 'user'));
  two.body.email = '  RIDER@EXAMPLE.COM  ';
  assert.equal(identity(one, 'accountIp'), identity(two, 'accountIp'));
  two.headers['x-forwarded-for'] = '203.0.113.99';
  assert.equal(identity(one, 'ip'), identity(two, 'ip'));
  one.ip = '2001:db8:abcd:1200::1'; two.ip = '2001:db8:abcd:1200::2';
  assert.equal(identity(one, 'ip'), identity(two, 'ip'));
  const req = request(); delete req.user;
  assert.throws(() => identity(req, 'user'), /must follow protect/);
});
test('refresh rotation does not reset the account session quota', () => {
  process.env.JWT_REFRESH_SECRET = 'unit-test-secret';
  const a = request(), b = request();
  a.body.refreshToken = jwt.sign({ id: 'user', jti: 'a' }, process.env.JWT_REFRESH_SECRET);
  b.body.refreshToken = jwt.sign({ id: 'user', jti: 'b' }, process.env.JWT_REFRESH_SECRET);
  assert.equal(identity(a, 'session'), identity(b, 'session'));
});
test('Redis outage preserves reads, closes sensitive writes, and recovers', async () => {
  const store = { consume: async () => { throw new Error('offline'); } };
  assert.equal((await invoke(createLimiter('userRead', { store }))).status, 200);
  const login = createLimiter('login', { store });
  const result = await invoke(login);
  assert.equal(result.status, 503);
  assert.equal(result.headers['Retry-After'], 5);
  const memory = new MemoryWindowStore();
  store.consume = memory.consume.bind(memory);
  assert.equal((await invoke(login)).status, 200);
});

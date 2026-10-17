const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const EarlyInterest = require('../src/models/EarlyInterest.model');

test('admin and helper read saved interests; public and customer accounts cannot', async (t) => {
  t.mock.method(require('../src/queues/interestEmail.queue'), 'scheduleInterestEmails', () => {});
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  let role = 'ADMIN';
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => ({ _id: 'staff-test', role, status: 'active' }) }) }));
  const record = { _id: 'interest-test', name: 'Rider', email: 'rider@example.com', city: 'Hyderabad', priceRange: '5999-6999', confirmationEmailStatus: 'sent' };
  t.mock.method(EarlyInterest, 'find', () => ({ sort: order => {
    assert.deepEqual(order, { createdAt: -1 });
    return { skip: offset => {
      assert.equal(offset, 0);
      return { limit: limit => {
        assert.equal(limit, 100);
        return { lean: async () => [record] };
      } };
    } };
  } }));
  t.mock.method(EarlyInterest, 'countDocuments', async () => 1);
  const app = express();
  app.use('/api/early-interest', require('../src/routes/earlyInterestRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = jwt.sign({ id: 'staff-test' }, process.env.JWT_SECRET);
  const get = authenticated => fetch(`http://127.0.0.1:${server.address().port}/api/early-interest?page=1`, {
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await get(false)).status, 401);
  for (role of ['ADMIN', 'HELPER']) {
    const response = await get(true);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.items, [record]);
    assert.equal(body.data.total, 1);
  }
  role = 'USER';
  assert.equal((await get(true)).status, 403);
});

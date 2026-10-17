const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Interest = require('../src/models/EarlyInterest.model');

test('interest saves supported price ranges, rejects invalid input and accepts older clients', async t => {
  const saved = [];
  t.mock.method(Interest, 'exists', async () => false);
  t.mock.method(Interest, 'create', async record => { saved.push(record); return { _id: 'fixture' }; });
  t.mock.method(Interest, 'updateOne', async () => ({}));
  t.mock.method(require('../src/queues/interestEmail.queue'), 'scheduleInterestEmails', () => {});
  t.mock.method(require('../src/services/email.service'), 'sendEmail', async () => ({ sent: true, code: 'SENT' }));
  const app = express();
  app.use(express.json());
  app.use('/', require('../src/routes/earlyInterestRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const submit = fields => fetch(`http://127.0.0.1:${server.address().port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Rider', email: 'test@example.com', city: 'Hyderabad', ...fields }),
  });
  for (const invalid of ['8999-9999', { value: '4999-5999' }]) {
    assert.equal((await submit({ priceRange: invalid })).status, 400);
  }
  assert.equal(saved.length, 0);
  assert.equal((await submit({ priceRange: '7999-8999' })).status, 201);
  assert.equal(saved[0].priceRange, '7999-8999');
  assert.equal((await submit({})).status, 201);
  assert.equal(saved[1].priceRange, '');
  for (const priceRange of ['4999-5999', '5999-6999', '6999-7999', '7999-8999']) {
    assert.equal(new Interest({ name: 'Rider', email: 'test@example.com', city: 'City', priceRange }).validateSync(), undefined);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const Interest = require('../src/models/EarlyInterest.model');
const email = require('../src/services/email.service');
const queue = require('../src/queues/interestEmail.queue');

function fakeQueue(t, record) {
  t.mock.method(Interest, 'findOneAndUpdate', filter => {
    assert.equal(filter.confirmationEmailStatus, 'queued');
    const eligible = record?.confirmationEmailStatus === 'queued' &&
      (!record.confirmationEmailNextAttemptAt || record.confirmationEmailNextAttemptAt <= new Date());
    const claimed = eligible ? { ...record } : null;
    if (claimed) record.confirmationEmailStatus = 'sending';
    return { lean: async () => claimed };
  });
  t.mock.method(Interest, 'updateOne', async (filter, update) => {
    assert.equal(filter.confirmationEmailStatus, 'sending');
    Object.assign(record, update.$set);
    return { modifiedCount: 1 };
  });
}

test('email work starts after response finish; duplicate workers cannot resend', async t => {
  const record = { _id: 'fixture', email: 'test@example.com', name: 'Rider', confirmationEmailStatus: 'queued' };
  fakeQueue(t, record);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const send = t.mock.method(email, 'sendEmail', async () => { await blocked; return { sent: true, code: 'SENT' }; });
  const response = new EventEmitter();
  const task = queue.scheduleInterestEmails(response);
  await Promise.resolve();
  assert.equal(send.mock.callCount(), 0);
  response.emit('finish');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 1);
  assert.equal(record.confirmationEmailStatus, 'sending');
  await queue.drainInterestEmails();
  assert.equal(send.mock.callCount(), 1);
  release();
  await task;
  assert.equal(record.confirmationEmailStatus, 'sent');
  await queue.drainInterestEmails();
  assert.equal(send.mock.callCount(), 1);
});

test('ambiguous SMTP timeout is recorded without automatic resend', async t => {
  const record = { _id: 'fixture', email: 'test@example.com', name: 'Rider', confirmationEmailStatus: 'queued' };
  fakeQueue(t, record);
  const send = t.mock.method(email, 'sendEmail', async () => ({ sent: false, code: 'TIMEOUT' }));
  await queue.drainInterestEmails();
  assert.equal(record.confirmationEmailStatus, 'failed');
  assert.equal(record.confirmationEmailCode, 'TIMEOUT');
  await queue.drainInterestEmails();
  assert.equal(send.mock.callCount(), 1);
});

test('unsent provider quota failures remain queued with a future attempt time', async t => {
  const record = { _id: 'fixture', email: 'test@example.com', name: 'Rider', confirmationEmailStatus: 'queued' };
  fakeQueue(t, record);
  const send = t.mock.method(email, 'sendEmail', async () => ({ sent: false, code: 'HOURLY_LIMIT' }));
  await queue.drainInterestEmails();
  assert.equal(record.confirmationEmailStatus, 'queued');
  assert.ok(record.confirmationEmailNextAttemptAt.getTime() > Date.now() + 59 * 60 * 1000);
  await queue.drainInterestEmails();
  assert.equal(send.mock.callCount(), 1);
});

test('provider acceptance followed by a database failure is never automatically resent', async t => {
  const record = { _id: 'fixture', email: 'test@example.com', name: 'Rider', confirmationEmailStatus: 'queued' };
  fakeQueue(t, record);
  t.mock.method(Interest, 'updateOne', async () => { throw new Error('database unavailable'); });
  const send = t.mock.method(email, 'sendEmail', async () => ({ sent: true, code: 'SENT' }));
  await assert.rejects(queue.drainInterestEmails(), /database unavailable/);
  assert.equal(record.confirmationEmailStatus, 'sending');
  await queue.drainInterestEmails();
  assert.equal(send.mock.callCount(), 1);
});

test('API returns before SMTP completes and concurrent duplicate inserts queue once', async t => {
  const records = new Map();
  const tasks = [];
  const schedule = queue.scheduleInterestEmails;
  t.mock.method(queue, 'scheduleInterestEmails', response => { const task = schedule(response); tasks.push(task); return task; });
  t.mock.method(Interest, 'exists', async () => false); // Two requests pass the preliminary check.
  t.mock.method(Interest, 'create', async record => {
    if (records.has(record.email)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    records.set(record.email, { ...record, _id: 'fixture' });
  });
  t.mock.method(Interest, 'findOneAndUpdate', () => {
    const record = [...records.values()].find(row => row.confirmationEmailStatus === 'queued');
    if (record) record.confirmationEmailStatus = 'sending';
    return { lean: async () => record || null };
  });
  t.mock.method(Interest, 'updateOne', async (_, update) => Object.assign([...records.values()][0], update.$set));
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const send = t.mock.method(email, 'sendEmail', async () => { await blocked; return { sent: true, code: 'SENT' }; });
  const app = express();
  app.use(express.json());
  delete require.cache[require.resolve('../src/routes/earlyInterestRoutes')];
  app.use('/', require('../src/routes/earlyInterestRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { release(); await Promise.all(tasks); await new Promise(resolve => server.close(resolve)); });
  const submit = address => fetch(`http://127.0.0.1:${server.address().port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rider', city: 'Hyderabad', email: address }),
  });
  const responses = await Promise.all([submit(' RIDER@example.com '), submit('rider@example.com')]);
  assert.deepEqual(responses.map(res => res.status).sort(), [200, 201]);
  assert.equal(records.size, 1);
  assert.equal(tasks.length, 1);
  assert.equal(send.mock.callCount(), 1); // HTTP responses arrived while SMTP is still blocked.
  const body = await responses.find(res => res.status === 201).json();
  assert.equal(body.data.confirmationEmailStatus, 'queued');
  release();
  await Promise.all(tasks);
  assert.equal(send.mock.callCount(), 1);
});

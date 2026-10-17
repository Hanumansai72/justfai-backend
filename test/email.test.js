const { test } = require('node:test');
const assert = require('node:assert/strict');
const EmailLimit = require('../src/models/EmailLimit.model');
const { sendEmail, sendInterestUpdate } = require('../src/services/email.service');
const templates = require('../src/services/email.templates');
const nodemailer = require('nodemailer');

test('Hostinger payload, safe failures, throttling and save-before-queue', async (t) => {
  process.env.MAIL_PROVIDER = 'hostinger-smtp';
  process.env.MAIL_FROM_EMAIL = 'info@justride.cc';
  process.env.MAIL_FROM_NAME = 'JustRide';
  process.env.MAIL_HOST = 'smtp.hostinger.com';
  process.env.MAIL_PORT = '465';
  process.env.MAIL_SECURE = 'true';
  process.env.MAIL_USER = 'info@justride.cc';
  process.env.MAIL_PASSWORD = 'test-only-secret';
  t.mock.method(EmailLimit, 'updateOne', async () => ({}));
  const claim = t.mock.method(EmailLimit, 'findOneAndUpdate', async () => ({}));
  let payload;
  const httpFetch = globalThis.fetch;
  const request = t.mock.fn(async (message) => { payload = message; return { accepted: [message.to] }; });
  t.mock.method(nodemailer, 'createTransport', (options) => {
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.logger, false);
    assert.equal(options.port, 465);
    return { sendMail: request, close: () => {} };
  });
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const email = { to: 'rider@example.com', ...templates.interestConfirmation('<rider>', true) };
  assert.deepEqual(await sendEmail(email), { sent: true, code: 'SENT' });
  assert.deepEqual(payload.from, { name: 'JustRide', address: 'info@justride.cc' });
  assert.equal(payload.replyTo, 'info@justride.cc');
  assert.equal(payload.to, 'rider@example.com');
  assert.ok(payload.html.includes('&lt;rider&gt;'));
  assert.ok(payload.text.includes('early access'));
  assert.ok(templates.interestConfirmation('Rider').text.includes('not subscribed'));
  request.mock.mockImplementation(async () => { throw Object.assign(new Error('test-only-secret'), { code: 'EAUTH' }); });
  assert.equal((await sendEmail(email)).code, 'AUTH_FAILED');
  request.mock.mockImplementation(async () => { throw Object.assign(new Error('test-only-secret'), { responseCode: 452 }); });
  assert.equal((await sendEmail(email)).code, 'PROVIDER_LIMIT');
  request.mock.mockImplementation(async () => { throw Object.assign(new Error('test-only-secret'), { code: 'ETIMEDOUT' }); });
  assert.equal((await sendEmail(email)).code, 'TIMEOUT');
  claim.mock.mockImplementation(async () => null);
  assert.equal((await sendEmail(email)).code, 'RECIPIENT_LIMIT');
  assert.equal((await sendEmail({ ...email, to: 'invalid' })).code, 'INVALID_MESSAGE');
  assert.ok(!warnings.join('').includes('test-only-secret'));
  assert.ok(!warnings.join('').includes('rider@example.com'));
  const reset = templates.passwordReset('Rider', 'a'.repeat(64));
  assert.ok(reset.text.includes('/reset-password#'));

  const EarlyInterest = require('../src/models/EarlyInterest.model');
  let saved = false;
  const records = new Map();
  const exists = t.mock.method(EarlyInterest, 'exists', async (query) => {
    const record = records.get(query.email);
    return query.emailConsent === true ? record?.emailConsent === true : Boolean(record);
  });
  t.mock.method(EarlyInterest, 'create', async (record) => {
    records.set(record.email, record);
    saved = true;
    return { _id: 'test' };
  });
  const queued = t.mock.method(require('../src/queues/interestEmail.queue'), 'scheduleInterestEmails', () => { assert.ok(saved); });
  const service = require('../src/services/email.service');
  t.mock.method(service, 'sendEmail', async () => { assert.ok(saved); return { sent: false, code: 'TIMEOUT' }; });
  // Isolate route tests from auth's Redis connections; auth behavior is unchanged.
  const authPath = require.resolve('../src/middlewares/authMiddleware');
  const prior = require.cache[authPath];
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true,
    exports: { protect: (_req, _res, next) => next(), authorize: () => (_req, _res, next) => next() } };
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/', require('../src/routes/earlyInterestRoutes'));
  if (prior) require.cache[authPath] = prior; else delete require.cache[authPath];
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const submit = (fields = {}) => httpFetch(`http://127.0.0.1:${server.address().port}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rider', email: 'rider@example.com', city: 'Hyderabad', emailConsent: true, ...fields }),
  });
  assert.equal((await submit({ emailConsent: 'false' })).status, 400);
  assert.equal((await submit()).status, 201);
  assert.ok(saved);
  assert.equal(records.get('rider@example.com').confirmationEmailStatus, 'queued');
  assert.equal(queued.mock.callCount(), 1);
  assert.equal(records.get('rider@example.com').emailConsent, true);
  assert.ok(records.get('rider@example.com').emailConsentAt instanceof Date);
  assert.equal((await submit({ emailConsent: true })).status, 200);
  assert.equal(records.get('rider@example.com').emailConsent, true);
  assert.equal(service.sendEmail.mock.callCount(), 0);
  assert.equal(queued.mock.callCount(), 1);
  assert.equal((await submit({ email: 'subscriber@example.com', emailConsent: true, emailConsentAt: 'untrusted' })).status, 201);
  const subscriber = records.get('subscriber@example.com');
  assert.ok(subscriber.emailConsentAt instanceof Date);
  assert.ok(subscriber.emailConsentText.startsWith('I agree to receive JustRide emails'));

  claim.mock.mockImplementation(async () => ({}));
  request.mock.mockImplementation(async (message) => ({ accepted: [message.to] }));
  const sendCount = request.mock.callCount();
  records.get('rider@example.com').emailConsent = false; // A legacy record without opt-in.
  assert.equal((await sendInterestUpdate(email)).code, 'CONSENT_REQUIRED');
  assert.equal(request.mock.callCount(), sendCount);
  assert.equal((await sendInterestUpdate({ ...email, to: 'subscriber@example.com' })).code, 'SENT');
  assert.equal(request.mock.callCount(), sendCount + 1);
  exists.mock.mockImplementation(async () => { throw new Error('database unavailable'); });
  assert.equal((await sendInterestUpdate(email)).code, 'CONSENT_CHECK_FAILED');
  assert.equal(request.mock.callCount(), sendCount + 1);
});

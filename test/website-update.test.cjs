const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'isolated-test-signing-secret';
process.env.PUBLIC_API_URL = 'https://backend.justride.cc';
const Campaign = require('../src/models/WebsiteUpdateCampaign.model');
const Interest = require('../src/models/EarlyInterest.model');
const email = require('../src/services/email.service');
const service = require('../src/services/websiteUpdateCampaign.service');
const { websiteUpdate, contentHash, TEST_RECIPIENT } = require('../src/services/websiteUpdate.template');
const { unsubscribeUrl, verifyUnsubscribe } = require('../src/services/interestUnsubscribe.service');
const id = '507f1f77bcf86cd799439011';
let document, audience, sent, optedIn, outcome;

function queryValue(value) { return { lean: async () => value }; }
beforeEach(() => {
  document = { key: service.KEY, state: 'draft', testStatus: 'not_sent', recipients: [] };
  audience = [{ _id: id, name: 'Preview Rider', email: 'preview@example.com' }];
  sent = []; optedIn = true; outcome = { sent: true, code: 'SENT' };
  Campaign.init = async () => {};
  Campaign.findOne = () => queryValue(document);
  Interest.countDocuments = async () => audience.length;
  Interest.find = () => ({ select: () => queryValue(audience) });
  Interest.exists = async () => optedIn;
  email.sendEmail = async message => { sent.push(message); await new Promise(resolve => setImmediate(resolve)); return outcome; };
  email.sendInterestUpdate = async message => { sent.push(message); return outcome; };
  Campaign.findOneAndUpdate = (filter, update) => {
    let result = null;
    if (filter.recipients) {
      const person = document.state === 'queued' && document.recipients.find(p => p.status === 'queued' && p.nextAttemptAt <= new Date());
      if (person) {
        person.status = 'sending'; person.claimId = update.$set['recipients.$.claimId'];
        result = structuredClone(document);
      }
      return queryValue(result);
    }
    const matches = document.state === filter.state &&
      (typeof filter.testStatus === 'object' ? document.testStatus !== filter.testStatus.$ne : document.testStatus === filter.testStatus) &&
      (!filter.testContentHash || document.testContentHash === filter.testContentHash);
    if (matches) { Object.assign(document, update.$set); result = document; }
    return Promise.resolve(result);
  };
  Campaign.updateOne = async (filter, update, options = {}) => {
    if (update.$setOnInsert) return;
    if (options.arrayFilters) {
      const person = document.recipients.find(p => p.claimId === options.arrayFilters[0]['person.claimId'] && p.status === 'sending');
      if (person) for (const [key, value] of Object.entries(update.$set)) person[key.split('.').at(-1)] = value;
    } else if (filter.recipients) {
      if (document.state === 'queued' && !document.recipients.some(p => ['queued', 'sending'].includes(p.status))) Object.assign(document, update.$set);
    } else Object.assign(document, update.$set);
  };
});

test('email has accurate copy, escapes names, and includes working links', () => {
  const message = websiteUpdate('<script>bad</script>', 'https://backend.justride.cc/preference?a=1&b=2');
  assert.ok(message.html.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(!message.html.includes('<script>'));
  assert.ok(message.text.includes('Price coming soon.'));
  assert.ok(message.html.includes('https://justride.cc'));
  assert.ok(message.html.includes('Unsubscribe from product updates'));
  assert.ok(message.html.includes('a=1&amp;b=2'));
  assert.ok(!message.text.includes('10–12'));
});

test('unsubscribe tokens validate only the signed recipient', () => {
  const token = new URL(unsubscribeUrl(id)).searchParams.get('token');
  assert.equal(verifyUnsubscribe(token), id);
  assert.equal(verifyUnsubscribe(token.replace(id, '507f1f77bcf86cd799439012')), null);
  assert.equal(verifyUnsubscribe(token + '.extra'), null);
  assert.equal(verifyUnsubscribe('<script>alert(1)</script>'), null);
  assert.equal(verifyUnsubscribe(['unexpected']), null);
});

test('testing sends only the explicitly configured test address and leaves campaign in draft', async () => {
  await service.sendTest();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, TEST_RECIPIENT);
  assert.match(sent[0].subject, /^\[TEST\]/);
  assert.equal(document.state, 'draft');
  assert.deepEqual(document.recipients, []);
  assert.equal(document.testStatus, 'sent');
  assert.equal(document.testContentHash, contentHash());
});

test('concurrent test requests cannot send the test twice', async () => {
  const results = await Promise.allSettled([service.sendTest(), service.sendTest()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(sent.length, 1);
});

test('bulk approval rejects missing approval, stale counts and an untested email', async () => {
  await assert.rejects(service.approve({ expectedRecipients: 1 }), { statusCode: 400 });
  await assert.rejects(service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: 2 }), { statusCode: 409 });
  await assert.rejects(service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: 1 }), { statusCode: 409 });
  assert.equal(document.state, 'draft');
  assert.equal(sent.length, 0);
});

test('approval snapshots the audience once and rejects repeat approval', async () => {
  document.testStatus = 'sent'; document.testContentHash = contentHash();
  await service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: 1 });
  assert.equal(document.state, 'queued');
  assert.equal(document.recipients.length, 1);
  await assert.rejects(service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: 1 }), { statusCode: 409 });
  assert.equal(sent.length, 0);
});

function queue() {
  document.state = 'queued'; document.recipients = [{ interestId: id, name: 'Preview', email: 'preview@example.com', status: 'queued', nextAttemptAt: new Date(0) }];
}

test('the worker does nothing before approval', async () => {
  assert.equal(await service.drainWebsiteUpdates(), 0);
  assert.equal(sent.length, 0);
});

test('a sent recipient cannot be sent again by repeated workers', async () => {
  queue(); await service.drainWebsiteUpdates(); await service.drainWebsiteUpdates();
  assert.equal(sent.length, 1);
  assert.equal(document.recipients[0].status, 'sent');
  assert.equal(document.state, 'completed');
});

test('revoked consent skips delivery', async () => {
  queue(); optedIn = false; await service.drainWebsiteUpdates();
  assert.equal(sent.length, 0);
  assert.equal(document.recipients[0].status, 'skipped');
});

test('hourly limits postpone the recipient without losing it', async () => {
  queue(); outcome = { sent: false, code: 'HOURLY_LIMIT' }; await service.drainWebsiteUpdates();
  assert.equal(document.recipients[0].status, 'queued');
  assert.ok(document.recipients[0].nextAttemptAt.getTime() > Date.now() + 3500000);
  await service.drainWebsiteUpdates(); assert.equal(sent.length, 1);
});

test('an ambiguous SMTP timeout is never automatically retried', async () => {
  queue(); outcome = { sent: false, code: 'TIMEOUT' }; await service.drainWebsiteUpdates(); await service.drainWebsiteUpdates();
  assert.equal(sent.length, 1);
  assert.equal(document.recipients[0].status, 'failed');
});

test('a crashed worker leaves sending state untouched for review', async () => {
  queue(); document.recipients[0].status = 'sending';
  await service.drainWebsiteUpdates();
  assert.equal(sent.length, 0);
  assert.equal(document.recipients[0].status, 'sending');
  assert.equal(document.state, 'queued');
});


test('directly confirmed contacts require an explicit campaign permission note', async () => {
  document.testStatus = 'sent'; document.testContentHash = contentHash();
  await assert.rejects(service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: 1, includeContacted: true }), { statusCode: 400 });
  assert.equal(document.state, 'draft');
});

test('owner-confirmed permission is recorded without changing saved consent', async () => {
  audience[0].emailConsent = false;
  document.testStatus = 'sent'; document.testContentHash = contentHash();
  await service.approve({ confirmation: service.CONFIRMATION, expectedRecipients: 1, includeContacted: true, permissionNote: 'Owner confirmed permission directly.' });
  assert.equal(document.includeContacted, true);
  assert.equal(document.recipients[0].permissionBasis, 'owner_confirmed_direct');
  assert.equal(audience[0].emailConsent, false);
  await service.drainWebsiteUpdates();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /confirmed you would like/);
});

test('direct permission never overrides a recorded unsubscribe', async () => {
  queue(); document.includeContacted = true;
  document.recipients[0].permissionBasis = 'owner_confirmed_direct';
  let checked;
  Interest.exists = async filter => { checked = filter; return false; };
  await service.drainWebsiteUpdates();
  assert.equal(checked.emailUnsubscribedAt, null);
  assert.equal(sent.length, 0);
  assert.equal(document.recipients[0].status, 'skipped');
});

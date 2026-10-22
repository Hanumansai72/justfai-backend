const { randomUUID } = require('node:crypto');
const Campaign = require('../models/WebsiteUpdateCampaign.model');
const EarlyInterest = require('../models/EarlyInterest.model');
const { getOutgoingQuota } = require('./mailQuota.service');
const email = require('./email.service');
const { websiteUpdate, contentHash, SUBJECT, TEST_RECIPIENT } = require('./websiteUpdate.template');
const { unsubscribeUrl } = require('./interestUnsubscribe.service');

const KEY = 'aventura-website-refresh-v1';
const CONFIRMATION = 'APPROVE_WEBSITE_UPDATE';
const audienceQuery = includeContacted => includeContacted ? { emailUnsubscribedAt: null } : { emailConsent: true, emailUnsubscribedAt: null };

async function ensureDraft() {
  await Campaign.init();
  try {
    await Campaign.updateOne({ key: KEY }, { $setOnInsert: { key: KEY } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
}

async function status() {
  const [campaign, eligibleCount, contactedCount, quota] = await Promise.all([
    Campaign.findOne({ key: KEY }).lean(), EarlyInterest.countDocuments(audienceQuery(false)),
    EarlyInterest.countDocuments(audienceQuery(true)), getOutgoingQuota(),
  ]);
  const counts = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const recipient of campaign?.recipients || []) counts[recipient.status]++;
  const queuedTimes = campaign?.recipients?.filter(p => p.status === 'queued').map(p => new Date(p.nextAttemptAt || 0).getTime()) || [];
  const nextAttemptAt = queuedTimes.length ? new Date(Math.max(Date.now(), Math.min(...queuedTimes), quota.pausedUntil ? new Date(quota.pausedUntil).getTime() : 0)) : null;
  return {
    key: KEY, subject: SUBJECT, state: campaign?.state || 'draft', eligibleCount, contactedCount,
    includeContacted: campaign?.includeContacted || false, permissionNote: campaign?.permissionNote,
    nextAttemptAt, quota,
    total: campaign?.recipients?.length || 0, counts,
    testRecipient: TEST_RECIPIENT,
    testStatus: campaign?.testStatus || 'not_sent', testCode: campaign?.testCode,
    testSentAt: campaign?.testSentAt,
    testedCurrentContent: campaign?.testStatus === 'sent' && campaign.testContentHash === contentHash(),
    approvedAt: campaign?.approvedAt,
    previewHtml: websiteUpdate('rider', '', true).html,
  };
}

async function sendTest() {
  await ensureDraft();
  const claimed = await Campaign.findOneAndUpdate({ key: KEY, state: 'draft', testStatus: { $ne: 'sending' } },
    { $set: { testStatus: 'sending', testCode: 'PROCESSING', testStartedAt: new Date(), testContentHash: contentHash() } }, { returnDocument: 'after' });
  if (!claimed) throw Object.assign(new Error('A test is already in progress or this campaign was already approved. Refresh its status before trying again.'), { statusCode: 409 });
  let result;
  try { result = await email.sendEmail({ to: TEST_RECIPIENT, ...websiteUpdate('Hanuman', '', true) }); }
  catch { result = { sent: false, code: 'DELIVERY_FAILED' }; }
  await Campaign.updateOne({ key: KEY, testStatus: 'sending' }, { $set: {
    testStatus: result.sent ? 'sent' : 'failed', testCode: result.code,
    ...(result.sent ? { testSentAt: new Date() } : {}),
  } });
  return result;
}

async function approve({ confirmation, expectedRecipients, approvedBy, includeContacted = false, permissionNote = '', approvalSource = 'admin' }) {
  if (confirmation !== CONFIRMATION || !Number.isSafeInteger(expectedRecipients)) {
    throw Object.assign(new Error('Explicit campaign approval and the reviewed recipient count are required.'), { statusCode: 400 });
  }
  if (typeof includeContacted !== 'boolean' || (includeContacted && (typeof permissionNote !== 'string' || permissionNote.trim().length < 12 || permissionNote.length > 500))) throw Object.assign(new Error('Record the direct permission confirmed for this audience.'), { statusCode: 400 });
  const recipients = await EarlyInterest.find(audienceQuery(includeContacted)).select('_id name email emailConsent').lean();
  if (recipients.length !== expectedRecipients) throw Object.assign(new Error('The eligible audience changed. Refresh the preview and approve the new count.'), { statusCode: 409 });
  if (!recipients.length || recipients.length > 5000) throw Object.assign(new Error('The recipient count must be between 1 and 5000.'), { statusCode: 400 });
  // Validate signing/configuration before any audience is committed to the queue.
  unsubscribeUrl(recipients[0]._id);
  const campaign = await Campaign.findOneAndUpdate({ key: KEY, state: 'draft', testStatus: 'sent', testContentHash: contentHash() }, { $set: {
    state: 'queued', approvedAt: new Date(), approvedBy, includeContacted, permissionNote: permissionNote.trim(), approvalSource,
    recipients: recipients.map(person => ({ interestId: person._id, name: person.name, email: person.email, permissionBasis: person.emailConsent === true ? 'recorded_opt_in' : 'owner_confirmed_direct', status: 'queued', nextAttemptAt: new Date(0) })),
  } }, { returnDocument: 'after' });
  if (!campaign) throw Object.assign(new Error('Send a successful test of the current email first. An approved campaign cannot be queued twice.'), { statusCode: 409 });
  return { queued: recipients.length };
}

async function drainWebsiteUpdates(limit = 1) {
  let processed = 0;
  while (processed < limit) {
    if ((await getOutgoingQuota()).pausedUntil) break;
    const claimId = randomUUID();
    const campaign = await Campaign.findOneAndUpdate({ key: KEY, state: 'queued', recipients: {
      $elemMatch: { status: 'queued', nextAttemptAt: { $lte: new Date() } },
    } }, { $set: { 'recipients.$.status': 'sending', 'recipients.$.claimId': claimId, 'recipients.$.startedAt': new Date() } }, { returnDocument: 'after' }).lean();
    if (!campaign) break;
    const recipient = campaign.recipients.find(person => person.claimId === claimId);
    let delivery;
    try {
      // Direct permission is specific to this approved campaign. Saved website consent is never rewritten.
      const directPermission = campaign.includeContacted === true && recipient.permissionBasis === 'owner_confirmed_direct';
      const allowed = await EarlyInterest.exists({ _id: recipient.interestId, email: recipient.email, emailUnsubscribedAt: null, ...(directPermission ? {} : { emailConsent: true }) });
      delivery = allowed
        ? await (directPermission ? email.sendEmail : email.sendInterestUpdate)({ to: recipient.email, ...websiteUpdate(recipient.name, unsubscribeUrl(recipient.interestId), false, directPermission) })
        : { sent: false, code: 'CONSENT_REQUIRED' };
    } catch { delivery = { sent: false, code: 'DELIVERY_FAILED' }; }
    const delays = { DAILY_LIMIT: 24 * 60 * 60 * 1000, HOURLY_LIMIT: 60 * 60 * 1000, RECIPIENT_LIMIT: 15 * 60 * 1000, NOT_CONFIGURED: 5 * 60 * 1000 };
    let delay = delays[delivery.code];
    if (delivery.code === 'DAILY_LIMIT' || delivery.code === 'HOURLY_LIMIT') {
      const quota = await getOutgoingQuota();
      if (quota.pausedUntil) delay = Math.max(1000, new Date(quota.pausedUntil).getTime() - Date.now() + 1000);
    }
    const nextStatus = delivery.sent ? 'sent' : delay ? 'queued' : delivery.code === 'CONSENT_REQUIRED' ? 'skipped' : 'failed';
    await Campaign.updateOne({ key: KEY }, { $set: {
      'recipients.$[person].status': nextStatus,
      'recipients.$[person].code': delivery.code,
      ...(delivery.sent ? { 'recipients.$[person].sentAt': new Date() } : {}),
      ...(delay ? { 'recipients.$[person].nextAttemptAt': new Date(Date.now() + delay) } : {}),
    } }, { arrayFilters: [{ 'person.claimId': claimId, 'person.status': 'sending' }] });
    processed++;
    if (delay) break;
  }
  // A sending record is never reclaimed: SMTP may have accepted it before a crash.
  await Campaign.updateOne({ key: KEY, state: 'queued', recipients: { $not: { $elemMatch: { status: { $in: ['queued', 'sending'] } } } } }, { $set: { state: 'completed' } });
  return processed;
}

function scheduleWebsiteUpdates(res) {
  const { waitUntil } = require('@vercel/functions');
  const task = new Promise(resolve => res.once('finish', resolve)).then(() => drainWebsiteUpdates())
    .catch(() => console.error('[website-update] QUEUE_PROCESSING_FAILED'));
  waitUntil(task);
  return task;
}

module.exports = { status, sendTest, approve, drainWebsiteUpdates, scheduleWebsiteUpdates, KEY, CONFIRMATION };

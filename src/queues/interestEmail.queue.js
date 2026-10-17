const { waitUntil } = require('@vercel/functions');
const EarlyInterest = require('../models/EarlyInterest.model');
const emailService = require('../services/email.service');
const { interestConfirmation } = require('../services/email.templates');

// The interest record is the durable queue entry: save and enqueue are one Mongo write.
async function drainInterestEmails(limit = 3) {
  let processed = 0;
  while (processed < limit) {
    const interest = await EarlyInterest.findOneAndUpdate({
      confirmationEmailStatus: 'queued',
      $or: [{ confirmationEmailNextAttemptAt: null }, { confirmationEmailNextAttemptAt: { $lte: new Date() } }],
    }, { $set: { confirmationEmailStatus: 'sending', confirmationEmailCode: 'PROCESSING', confirmationEmailStartedAt: new Date() } },
    { new: true, sort: { createdAt: 1 } }).lean();
    if (!interest) break;
    // Atomic queued -> sending means concurrent workers cannot send the same record.
    // Never reclaim 'sending': a crashed SMTP call may already have delivered the email.
    const delivery = interest.emailConsent === true
      ? await emailService.sendEmail({ to: interest.email, ...interestConfirmation(interest.name, true) })
      : { sent: false, code: 'CONSENT_REQUIRED' };
    const delay = { RECIPIENT_LIMIT: 15 * 60 * 1000, HOURLY_LIMIT: 60 * 60 * 1000, NOT_CONFIGURED: 5 * 60 * 1000 }[delivery.code];
    await EarlyInterest.updateOne({ _id: interest._id, confirmationEmailStatus: 'sending' }, { $set: {
      confirmationEmailStatus: delivery.sent ? 'sent' : delay ? 'queued' : 'failed',
      confirmationEmailCode: delivery.code,
      confirmationEmailNextAttemptAt: delay ? new Date(Date.now() + delay) : null,
    } });
    processed++;
  }
  return processed;
}

function scheduleInterestEmails(res) {
  // Register in Vercel's request context before responding; do SMTP only after finish.
  const task = new Promise(resolve => res.once('finish', resolve))
    .then(() => drainInterestEmails())
    .catch(() => console.error('[interest-email] QUEUE_PROCESSING_FAILED'));
  waitUntil(task);
  return task;
}

module.exports = { drainInterestEmails, scheduleInterestEmails };

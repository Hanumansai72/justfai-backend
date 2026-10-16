const { createHash } = require('node:crypto');
const validator = require('validator');
const nodemailer = require('nodemailer');
const EmailLimit = require('../models/EmailLimit.model');
const EarlyInterest = require('../models/EarlyInterest.model');

// Database counters survive restarts and are shared by Vercel instances.
async function claim(key, windowMs, max) {
  const now = new Date();
  try {
    await EmailLimit.updateOne({ _id: key, $or: [{ resetAt: { $lte: now } }, { resetAt: { $exists: false } }] },
      { $set: { count: 0, resetAt: new Date(now.getTime() + windowMs) } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return Boolean(await EmailLimit.findOneAndUpdate({ _id: key, count: { $lt: max } }, { $inc: { count: 1 } }));
}

function failure(code) {
  // Never log provider bodies, recipients, credentials, tokens or message content.
  console.warn(`[email] ${code}`);
  return { sent: false, code };
}

async function sendEmail({ to, subject, html, text }) {
  if (typeof to !== 'string' || !validator.isEmail(to) || /[\r\n]/.test(to) ||
      typeof subject !== 'string' || /[\r\n]/.test(subject) || !html || !text) {
    return failure('INVALID_MESSAGE');
  }
  if (process.env.MAIL_PROVIDER !== 'hostinger-smtp' || !process.env.MAIL_PASSWORD ||
      process.env.MAIL_HOST !== 'smtp.hostinger.com' || process.env.MAIL_PORT !== '465' ||
      process.env.MAIL_SECURE !== 'true' || process.env.MAIL_USER !== 'info@justride.cc' ||
      process.env.MAIL_FROM_EMAIL !== 'info@justride.cc' || process.env.MAIL_FROM_NAME !== 'JustRide') {
    return failure('NOT_CONFIGURED');
  }
  let transport;
  let timer;
  try {
    const recipientKey = createHash('sha256').update(to.toLowerCase()).digest('hex');
    if (!await claim(`recipient:${recipientKey}`, 15 * 60 * 1000, 3)) return failure('RECIPIENT_LIMIT');
    // Any rolling 24 hours intersects at most 25 hourly windows: 25 * 36 = 900.
    // Leave at least 100 of the observed 1,000 messages for normal mailbox use.
    if (!await claim('hostinger-outgoing', 60 * 60 * 1000, 36)) return failure('HOURLY_LIMIT');
    transport = nodemailer.createTransport({
      host: process.env.MAIL_HOST, port: Number(process.env.MAIL_PORT), secure: true,
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000, dnsTimeout: 10000,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false, debug: false, transactionLog: false,
      disableFileAccess: true, disableUrlAccess: true,
    });
    const result = await Promise.race([
      transport.sendMail({
        from: { name: process.env.MAIL_FROM_NAME, address: process.env.MAIL_FROM_EMAIL },
        replyTo: process.env.MAIL_FROM_EMAIL, to, subject, html, text,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Mail timeout'), { code: 'ETIMEDOUT' })), 15000); }),
    ]);
    return result.accepted?.some(address => String(address).toLowerCase() === to.toLowerCase())
      ? { sent: true, code: 'SENT' } : failure('RECIPIENT_REJECTED');
  } catch (error) {
    return failure(({ EAUTH: 'AUTH_FAILED', ETIMEDOUT: 'TIMEOUT', EENVELOPE: 'RECIPIENT_REJECTED', ECONNECTION: 'CONNECTION_FAILED' })[error.code] ||
      (error.responseCode >= 400 && error.responseCode < 500 ? 'PROVIDER_LIMIT' : 'DELIVERY_FAILED'));
  } finally {
    clearTimeout(timer);
    transport?.close();
  }
  // Do not automatically retry an ambiguous timeout: the provider may have sent it.
}

// Future product/preorder updates must check the saved choice before each send.
// Confirmation, OTP and account-security emails continue through sendEmail.
async function sendInterestUpdate(message) {
  if (typeof message.to !== 'string') return failure('INVALID_MESSAGE');
  const to = message.to.trim().toLowerCase();
  try {
    if (!await EarlyInterest.exists({ email: to, emailConsent: true })) return failure('CONSENT_REQUIRED');
  } catch {
    return failure('CONSENT_CHECK_FAILED');
  }
  return sendEmail({ ...message, to });
}

module.exports = { sendEmail, sendInterestUpdate };

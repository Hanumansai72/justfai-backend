const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { protect, authorize } = require('../middlewares/authMiddleware');
const { adminReadLimiter, adminWriteLimiter, publicReadLimiter } = require('../security/rateLimiter');
const EarlyInterest = require('../models/EarlyInterest.model');
const service = require('../services/websiteUpdateCampaign.service');
const { verifyUnsubscribe } = require('../services/interestUnsubscribe.service');
const router = express.Router();
const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function unsubscribePage(message, token = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JustRide email preferences</title></head><body style="margin:0;background:#080a09;color:#eff1ed;font:16px/1.6 Arial,sans-serif"><main style="max-width:520px;margin:80px auto;padding:24px"><h1>Just<span style="color:#70e8a6">Ride</span></h1><p>${message}</p>${token ? `<form method="post" action="/api/early-interest/unsubscribe"><input type="hidden" name="token" value="${token}"><button style="padding:14px 24px;border:0;border-radius:24px;background:#70e8a6;color:#080a09;font-size:16px">Unsubscribe from product updates</button></form>` : '<a href="https://justride.cc" style="color:#70e8a6">Back to JustRide</a>'}</main></body></html>`;
}

router.get('/unsubscribe', publicReadLimiter, route(async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (!verifyUnsubscribe(req.query.token)) return res.status(400).type('html').send(unsubscribePage('This email preference link is invalid. Contact info@justride.cc for help.'));
  // Email scanners can visit links: only an explicit form submission changes consent.
  return res.type('html').send(unsubscribePage('You can stop receiving JustRide product and availability updates below. Account security emails are unaffected.', req.query.token));
}));
router.post('/unsubscribe', publicReadLimiter, route(async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const id = verifyUnsubscribe(req.body?.token);
  if (!id) return res.status(400).type('html').send(unsubscribePage('This email preference link is invalid. Contact info@justride.cc for help.'));
  await EarlyInterest.updateOne({ _id: id }, { $set: { emailConsent: false, emailUnsubscribedAt: new Date() } });
  return res.type('html').send(unsubscribePage('You are unsubscribed from JustRide product updates.'));
}));

router.get('/website-update/process', route(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const supplied = req.headers.authorization || '';
  const expected = secret ? `Bearer ${secret}` : '';
  if (!expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(401).json({ success: false, message: 'Scheduler authorization required.' });
  res.set('Cache-Control', 'no-store');
  const processed = await service.drainWebsiteUpdates();
  return res.json({ success: true, data: { processed } });
}));

router.use('/website-update', protect, authorize('ADMIN'));
router.get('/website-update', adminReadLimiter, route(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = await service.status();
  // Polling assists serverless deployments; a persistent worker or scheduler continues after the browser closes.
  if (data.state === 'queued') service.scheduleWebsiteUpdates(res);
  return res.json({ success: true, data });
}));
router.post('/website-update/test', adminWriteLimiter, route(async (req, res) => {
  const delivery = await service.sendTest();
  return res.status(delivery.sent ? 200 : 502).json({ success: delivery.sent, data: delivery,
    message: delivery.sent ? 'The test was accepted by the mail server. Check the preview inbox before approving the campaign.' : `Test email was not confirmed: ${delivery.code}. Check campaign status before retrying.` });
}));
router.post('/website-update/approve', adminWriteLimiter, route(async (req, res) => {
  const data = await service.approve({ ...req.body, approvedBy: req.user._id, approvalSource: 'admin' });
  service.scheduleWebsiteUpdates(res);
  return res.status(202).json({ success: true, data, message: 'Campaign approved and queued. Each message is sent individually within the shared mail limits.' });
}));

module.exports = router;

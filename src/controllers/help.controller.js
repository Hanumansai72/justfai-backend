const ownedAttachments = require('../utils/ownedAttachments');
const { randomUUID } = require('node:crypto');
const HelpFeedback = require('../models/HelpFeedback.model');
const SupportTicket = require('../models/SupportTicket.model');
const Device = require('../models/device.model');
const cloudinary = require('../config/cloudinary');
const { notifyNewTicket } = require('../queues/notification.queue');
const audit = require('../security/auditLogger');
const { waitUntil } = require('@vercel/functions');
const articles = require('../data/app-faqs.json');
const byId = new Map(articles.map(article => [article.id, article]));
const categories = ['device_problem', 'connection_issue', 'navigation_issue', 'firmware_problem', 'account_problem', 'contact_support', 'feedback', 'general'];
const error = (res, message) => res.status(400).json({ success: false, message });
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;

exports.saveFeedback = async (req, res, next) => {
  try {
    const { article_id, helpful } = req.body || {};
    if (!byId.has(article_id) || typeof helpful !== 'boolean') return error(res, 'Choose a valid help article and helpful/not helpful response.');
    await HelpFeedback.updateOne({ user_id: req.user._id, article_id }, { $set: { helpful } }, { upsert: true, runValidators: true });
    res.json({ success: true, message: 'Thank you for your feedback.' });
  } catch (err) {
    // Concurrent first votes can race on the unique index; apply the last vote.
    if (err.code === 11000) {
      try {
        await HelpFeedback.updateOne({ user_id: req.user._id, article_id: req.body.article_id }, { $set: { helpful: req.body.helpful } });
        return res.json({ success: true, message: 'Thank you for your feedback.' });
      } catch (retryError) { return next(retryError); }
    }
    next(err);
  }
};

exports.getFeedbackSummary = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [result] = await HelpFeedback.aggregate([
      { $group: { _id: '$article_id', helpful: { $sum: { $cond: ['$helpful', 1, 0] } },
        not_helpful: { $sum: { $cond: ['$helpful', 0, 1] } }, updatedAt: { $max: '$updatedAt' } } },
      { $sort: { not_helpful: -1, updatedAt: -1, _id: 1 } },
      { $facet: { items: [{ $skip: (page - 1) * 10 }, { $limit: 10 }], total: [{ $count: 'count' }] } },
    ]);
    const total = result?.total[0]?.count || 0;
    const data = (result?.items || []).map(item => ({ ...item, question: byId.get(item._id)?.question || item._id }));
    res.json({ success: true, data, pagination: { page, limit: 10, total, pages: Math.ceil(total / 10) } });
  } catch (err) { next(err); }
};

exports.uploadAttachment = async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'Choose a screenshot (JPEG, PNG or WebP, maximum 5 MB).');
    // Preserve screenshot aspect ratio and legibility instead of the display-image crop.
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({
        resource_type: 'image', public_id: `justride/users/${req.user._id}/support/${randomUUID()}`,
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto:good' }],
      }, (err, uploaded) => err ? reject(err) : resolve(uploaded));
      stream.end(req.file.buffer);
    });
    res.status(201).json({ success: true, data: { url: result.secure_url } });
  } catch (err) { next(err); }
};


exports.createTicket = async (req, res, next) => {
  try {
    const { subject, description, category, device_id, help_article_id, diagnostics, diagnostics_consent } = req.body || {};
    if (!text(subject, 3, 160) || !text(description, 10, 6000) || !categories.includes(category)) {
      return error(res, 'Choose an issue category, a subject (3–160 characters), and a description (10–6000 characters).');
    }
    if (help_article_id !== undefined && !byId.has(help_article_id)) return error(res, 'Invalid help article.');
    const attachments = ownedAttachments(req.body.attachments, req.user._id);
    if (!attachments) return error(res, 'Attach up to three screenshots uploaded by your account.');
    let details;
    if (diagnostics !== undefined) {
      if (diagnostics_consent !== true || !diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) return error(res, 'Diagnostic sharing requires your consent.');
      details = { consented_at: new Date() };
      for (const key of ['app_version', 'firmware_version', 'phone_model', 'platform', 'os_version', 'error_code']) {
        if (diagnostics[key] !== undefined) {
          if (!text(diagnostics[key], 1, ['phone_model', 'error_code'].includes(key) ? 160 : 80)) return error(res, 'Invalid diagnostic details.');
          details[key] = diagnostics[key].trim();
        }
      }
    }
    let device = null;
    if (device_id !== undefined) {
      if (typeof device_id !== 'string' || !/^[a-f\d]{24}$/i.test(device_id)) return error(res, 'Invalid device.');
      device = await Device.findOne({ _id: device_id, linked_to: req.user._id }).select('_id devicename device_id BLE_ADDRESS');
      if (!device) return res.status(403).json({ success: false, message: 'Only your linked device can be attached to this ticket.' });
    } else if (['device_problem', 'connection_issue', 'navigation_issue', 'firmware_problem'].includes(category)) {
      device = await Device.findOne({ linked_to: req.user._id, is_paired: true }).select('_id devicename device_id BLE_ADDRESS');
    }
    const ticket = await SupportTicket.create({ user_id: req.user._id, category, subject: subject.trim(),
      description: description.trim(), device_id: device?._id || null, help_article_id, diagnostics: details,
      messages: [{ sender_id: req.user._id, sender_role: 'USER', body: description.trim(), attachments }] });
    audit.log({ req, category: 'SYSTEM', action: 'SUPPORT_TICKET_CREATE', status: 'SUCCESS', resource_type: 'System',
      resource_id: ticket._id, message: 'Support ticket created from Help Center' });
    // The ticket is already saved. Notification delivery must not make the app
    // report a failed save and encourage duplicate submissions.
    waitUntil(Promise.resolve().then(() => notifyNewTicket({ ticket, customer: req.user, device }))
      .catch(() => { console.error('[Support] TICKET_NOTIFICATION_FAILED'); }));
    res.status(201).json({ success: true, data: ticket, message: 'Support ticket created.' });
  } catch (err) { next(err); }
};

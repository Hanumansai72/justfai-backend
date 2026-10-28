const mongoose = require('mongoose');
const PushInstallation = require('../models/PushInstallation.model');
const User = require('../models/User');
const FirmwareRelease = require('../models/FirmwareRelease.model');
const AppRelease = require('../models/AppRelease.model');
const push = require('../services/pushNotification.service');
const notifier = require('../services/releaseNotification.service');
const audit = require('../security/auditLogger');

const validFid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

exports.register = async (req, res, next) => {
  try {
    const { fid, enabled } = req.body;
    if (!validFid(fid) || typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: 'A valid installation ID and notification permission are required.' });
    await PushInstallation.updateOne({ fid }, { $set: { user_id: req.user._id, enabled } }, { upsert: true, runValidators: true });
    res.json({ success: true });
  } catch (error) { next(error); }
};

exports.unregister = async (req, res, next) => {
  try {
    if (!validFid(req.body.fid)) return res.status(400).json({ success: false, message: 'Invalid installation ID.' });
    await PushInstallation.deleteOne({ fid: req.body.fid, user_id: req.user._id });
    res.json({ success: true });
  } catch (error) { next(error); }
};

exports.status = async (req, res, next) => {
  try {
    const activeUsers = await User.distinct('_id', { role: 'USER', status: 'active' });
    const installations = await PushInstallation.countDocuments({ enabled: true, user_id: { $in: activeUsers } });
    res.json({ success: true, data: { configured: push.isConfigured(), installations } });
  } catch (error) { next(error); }
};

exports.sendRelease = async (req, res, next) => {
  try {
    const { kind, release_id } = req.body;
    if (!['firmware', 'apk'].includes(kind) || !mongoose.isValidObjectId(release_id)) return res.status(400).json({ success: false, message: 'Select a valid firmware or APK release.' });
    if (!push.isConfigured()) return res.status(503).json({ success: false, message: 'Firebase push delivery is not configured.' });
    const release = await (kind === 'firmware' ? FirmwareRelease : AppRelease).findOne({ _id: release_id, is_active: true }).lean();
    if (!release || (kind === 'apk' && release.platform !== 'android')) return res.status(404).json({ success: false, message: 'Active Android or firmware release not found.' });
    const result = await (kind === 'firmware' ? notifier.notifyFirmwareRelease(release) : notifier.notifyAppRelease(release));
    if (result.error) return res.status(502).json({ success: false, message: 'Release notification dispatch failed. Check backend logs.' });
    audit.log({ req, category: 'ADMIN', action: 'RELEASE_PUSH_SENT', status: 'SUCCESS', resource_type: 'System', resource_id: release_id, message: `${kind} ${release.version}: ${result.push?.accepted || 0} push messages accepted by FCM`, metadata: result.push });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

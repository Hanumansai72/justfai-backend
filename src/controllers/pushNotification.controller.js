const PushInstallation = require('../models/PushInstallation.model');

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

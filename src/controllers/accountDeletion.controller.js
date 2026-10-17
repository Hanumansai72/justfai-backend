const { randomInt, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const User = require('../models/User');
const Device = require('../models/device.model');
const { sendEmail } = require('../services/email.service');
const { accountDeletionOtp } = require('../services/email.templates');
const { clearTokenCookies } = require('../utils/tokenManager');
const { retireAccount } = require('../services/accountDeletion.service');
const audit = require('../security/auditLogger');

const fields = '+password +deletion_otp_hash +deletion_otp_nonce +deletion_otp_expires +deletion_otp_attempts +deletion_otp_ready';
const digest = (id, nonce, otp) => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured');
  return createHmac('sha256', process.env.JWT_SECRET).update(`account-delete:v1:${id}:${nonce}:${otp}`).digest('hex');
};
const rejectLinked = res => res.status(409).json({ success: false, code: 'DEVICE_LINKED',
  message: 'Unlink your device before deleting your account.' });

async function verifyPassword(req, res) {
  const user = await User.findOne({ _id: req.user._id, role: 'USER', status: 'active' }).select(fields);
  if (!user) { res.status(403).json({ success: false, message: 'Account deletion is unavailable.' }); return null; }
  if (user.auth_provider === 'local' && user.password &&
      (typeof req.body?.password !== 'string' || !await user.matchPassword(req.body.password))) {
    res.status(400).json({ success: false, message: 'Enter your current password to continue.' }); return null;
  }
  return user;
}

exports.getDeletionStatus = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    const user = await User.findById(req.user._id).select('email auth_provider');
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    const linkedDevice = await Device.findOne({ linked_to: req.user._id })
      .select('_id devicename device_id BLE_ADDRESS').lean();
    return res.json({ success: true, data: { linkedDevice, requiresPassword: user.auth_provider === 'local',
      email: user.email.replace(/^(.).*(@.*)$/, '$1***$2') } });
  } catch (error) { next(error); }
};

exports.requestDeletionOtp = async (req, res, next) => {
  try {
    const user = await verifyPassword(req, res);
    if (!user) return;
    if (await Device.exists({ linked_to: user._id })) return rejectLinked(res);
    const now = new Date(), nonce = randomUUID(), otp = String(randomInt(100000, 1000000));
    const hash = digest(user._id, nonce, otp);
    const claimed = await User.updateOne({ _id: user._id, status: 'active', $or: [
      { deletion_otp_sent_at: { $exists: false } },
      { deletion_otp_sent_at: { $lte: new Date(now.getTime() - 60000) } },
    ] }, { $set: { deletion_otp_hash: hash, deletion_otp_nonce: nonce,
      deletion_otp_expires: new Date(now.getTime() + 600000), deletion_otp_sent_at: now,
      deletion_otp_attempts: 0, deletion_otp_ready: false } });
    if (!claimed.modifiedCount) return res.status(429).set('Retry-After', '60')
      .json({ success: false, message: 'Please wait 60 seconds before requesting another code.' });
    const delivery = await sendEmail({ to: user.email, ...accountDeletionOtp(user.name, otp) });
    if (!delivery.sent) {
      await User.updateOne({ _id: user._id, deletion_otp_nonce: nonce }, { $unset: {
        deletion_otp_hash: '', deletion_otp_nonce: '', deletion_otp_expires: '', deletion_otp_ready: '',
      } });
      return res.status(503).json({ success: false, message: 'Unable to send your code. Please try again later.' });
    }
    const ready = await User.updateOne({ _id: user._id, deletion_otp_nonce: nonce, status: 'active' },
      { $set: { deletion_otp_ready: true } });
    if (!ready.modifiedCount) return res.status(400).json({ success: false,
      message: 'Account changed. Request another deletion code.' });
    audit.log({ req, category: 'AUTH', action: 'ACCOUNT_DELETE_OTP_REQUEST', status: 'SUCCESS',
      resource_type: 'User', resource_id: user._id, message: 'Account deletion code requested' });
    return res.json({ success: true, message: 'Deletion code sent to your registered email.',
      data: { expiresInSeconds: 600, resendAfterSeconds: 60 } });
  } catch (error) { next(error); }
};

exports.deleteAccount = async (req, res, next) => {
  try {
    const user = await verifyPassword(req, res);
    if (!user) return;
    if (await Device.exists({ linked_to: user._id })) return rejectLinked(res);
    if (!/^\d{6}$/.test(String(req.body?.otp || ''))) return res.status(400)
      .json({ success: false, message: 'Enter the six-digit deletion code from your email.' });
    const challenge = await User.findOneAndUpdate({ _id: user._id, status: 'active',
      deletion_otp_ready: true, deletion_otp_expires: { $gt: new Date() }, deletion_otp_attempts: { $lt: 5 },
    }, { $inc: { deletion_otp_attempts: 1 } }, { new: true }).select(fields);
    if (!challenge) return res.status(400).json({ success: false, message: 'Code expired or attempt limit reached. Request a new code.' });
    const expected = digest(user._id, challenge.deletion_otp_nonce, req.body.otp);
    const actual = challenge.deletion_otp_hash || '';
    if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      return res.status(400).json({ success: false, message: 'Incorrect deletion code.' });
    }
    await retireAccount(user._id, { nonce: challenge.deletion_otp_nonce, hash: actual });
    clearTokenCookies(res);
    audit.log({ req, category: 'AUTH', action: 'USER_DELETE_SELF', status: 'SUCCESS',
      resource_type: 'User', resource_id: user._id, message: 'Account deleted after device unlink and email verification' });
    return res.json({ success: true, message: 'Account deleted. This email and phone number cannot be used to register again.' });
  } catch (error) {
    if (error.code === 'DEVICE_LINKED') return rejectLinked(res);
    if (error.code === 'DELETE_NOT_ALLOWED') return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

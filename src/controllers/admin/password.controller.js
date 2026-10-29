const { randomInt, randomBytes, createHmac } = require('node:crypto');
const bcrypt = require('bcryptjs');
const Admin = require('../../models/Admin.model');
const { sendEmail } = require('../../services/email.service');
const { adminPasswordOtp } = require('../../services/email.templates');
const { clearTokenCookies } = require('../../utils/tokenManager');
const audit = require('../../security/auditLogger');
const digest = (id, nonce, otp) => createHmac('sha256', process.env.JWT_SECRET)
  .update(`${id}:${nonce}:${otp}`).digest('hex');
const invalid = res => res.status(400).json({ success: false, message: 'Incorrect or expired code, or attempt limit reached. Request a new code.' });

async function verifyPassword(req, res) {
  if (req.user.role !== 'ADMIN') { res.status(403).json({ success: false, message: 'Admin only.' }); return null; }
  if (typeof req.body?.currentPassword !== 'string' || req.body.currentPassword.length > 128) {
    res.status(400).json({ success: false, message: 'Enter your current password.' }); return null;
  }
  const account = await Admin.findById(req.user._id).select('+password');
  if (!account || !await account.matchPassword(req.body.currentPassword)) {
    res.status(400).json({ success: false, message: 'Current password is incorrect.' }); return null;
  }
  return account;
}

exports.requestOtp = async (req, res, next) => {
  try {
    const account = await verifyPassword(req, res); if (!account) return;
    const now = new Date(), nonce = randomBytes(16).toString('hex');
    const otp = String(randomInt(100000, 1000000));
    const challenge = await Admin.findOneAndUpdate({ _id: account._id, status: 'active', password: account.password,
      $or: [{ password_change_sent_at: { $exists: false } }, { password_change_sent_at: { $lte: new Date(now - 60000) } }],
    }, { $set: { password_change_nonce: nonce, password_change_hash: digest(account._id, nonce, otp),
      password_change_expires: new Date(now.getTime() + 600000), password_change_sent_at: now,
      password_change_attempts: 0, password_change_ready: false } }, { new: true }).select('_id');
    if (!challenge) return res.status(429).json({ success: false, message: 'Wait at least 60 seconds before requesting another code.' });
    const delivery = await sendEmail({ to: 'hanumansai72@gmail.com', ...adminPasswordOtp(otp) });
    if (!delivery.sent) {
      await Admin.updateOne({ _id: account._id, password_change_nonce: nonce }, { $unset: { password_change_hash: '', password_change_nonce: '', password_change_expires: '' }, $set: { password_change_ready: false } });
      return res.status(503).json({ success: false, message: 'Could not send the code. Please try again later.' });
    }
    const ready = await Admin.updateOne({ _id: account._id, password_change_nonce: nonce }, { $set: { password_change_ready: true } });
    if (!ready.modifiedCount) return invalid(res);
    audit.log({ req, category: 'ADMIN', action: 'ADMIN_PASSWORD_OTP_SENT', resource_type: 'User', resource_id: account._id, message: 'Admin password-change code sent.' });
    return res.json({ success: true, message: 'Code sent to hanumansai72@gmail.com. It expires in 10 minutes.', data: { resendAfterSeconds: 60 } });
  } catch (error) { next(error); }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { otp, newPassword } = req.body || {};
    if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return invalid(res);
    if (typeof newPassword !== 'string' || newPassword.length < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'Use a password of at least 8 characters and at most 72 bytes.' });
    }
    const account = await verifyPassword(req, res); if (!account) return;
    if (await account.matchPassword(newPassword)) return res.status(400).json({ success: false, message: 'Choose a different new password.' });
    const challenge = await Admin.findOneAndUpdate({ _id: account._id, status: 'active', password_change_ready: true,
      password_change_expires: { $gt: new Date() }, password_change_attempts: { $lt: 5 } },
      { $inc: { password_change_attempts: 1 } }, { new: true }).select('+password_change_nonce');
    if (!challenge) return invalid(res);
    const updated = await Admin.findOneAndUpdate({ _id: account._id, status: 'active', password: account.password,
      password_change_nonce: challenge.password_change_nonce,
      password_change_hash: digest(account._id, challenge.password_change_nonce, otp), password_change_ready: true,
      password_change_expires: { $gt: new Date() }, password_change_attempts: { $lte: 5 } }, {
      $set: { password: await bcrypt.hash(newPassword, 12), refresh_tokens: [], password_change_ready: false },
      $inc: { credential_version: 1 }, $unset: { password_change_hash: '', password_change_nonce: '', password_change_expires: '' },
    }, { new: true }).select('_id');
    if (!updated) return invalid(res);
    audit.log({ req, category: 'ADMIN', action: 'ADMIN_PASSWORD_CHANGED', resource_type: 'User', resource_id: account._id, message: 'Admin password changed with email OTP; existing sessions revoked.' });
    require('../../security/session').disconnectUser(account._id);
    clearTokenCookies(res);
    return res.json({ success: true, message: 'Password changed. Sign in again with your new password.' });
  } catch (error) { next(error); }
};

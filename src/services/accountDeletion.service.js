const mongoose = require('mongoose');
const User = require('../models/User');
const Device = require('../models/device.model');
const cache = require('./cache.service');

const cacheGroups = ['users', 'staff', 'devices', 'pairing', 'support', 'firmware', 'releases', 'dashboard', 'notifications'];
const deletionError = (message, code, status = 409) => Object.assign(new Error(message), { code, statusCode: status });

// The user row remains as an identity reservation. Credentials and personal
// content are removed; unique email/phone indexes prevent re-registration.
async function retireAccount(userId, challenge) {
  await mongoose.connection.transaction(async session => {
    const filter = { _id: userId, role: 'USER', status: { $ne: 'deleted' } };
    if (challenge) Object.assign(filter, {
      status: 'active', deletion_otp_nonce: challenge.nonce,
      deletion_otp_hash: challenge.hash, deletion_otp_ready: true,
      deletion_otp_expires: { $gt: new Date() }, deletion_otp_attempts: { $lte: 5 },
    });
    // Pairing writes this same user row in its transaction, so a concurrent
    // pairing and deletion cannot both commit using stale account state.
    const user = await User.findOne(filter).session(session);
    if (!user) throw deletionError('Account or deletion code is no longer valid.', 'DELETE_NOT_ALLOWED', 400);
    const retired = await User.findOneAndUpdate(filter, {
      $set: { name: 'Deleted account', status: 'deleted', status_reason: 'Account deleted by request',
        deleted_at: new Date(), phonenumber: user.phonenumber, refresh_tokens: [] },
      $unset: { password: '', google_id: '', username: '', avatar: '',
        password_reset_token: '', password_reset_expires: '', deletion_otp_hash: '',
        deletion_otp_nonce: '', deletion_otp_expires: '', deletion_otp_sent_at: '',
        deletion_otp_attempts: '', deletion_otp_ready: '', premium_until: '' },
    }, { new: true, session });
    if (!retired) throw deletionError('Account changed. Request another deletion code.', 'DELETE_NOT_ALLOWED', 400);
    if (await Device.exists({ linked_to: userId }).session(session)) {
      throw deletionError('Unlink your device before deleting your account.', 'DEVICE_LINKED');
    }
    for (const name of ['Saved_address.model', 'Ride.model', 'SupportTicket.model', 'HelpFeedback.model']) {
      await require('../models/' + name).deleteMany({ user_id: userId }, { session });
    }
    await require('../models/Notification.model').deleteMany({ $or: [
      { user_id: userId }, { recipient_id: userId, recipient_model: 'User' },
    ] }, { session });
    await require('../models/PushInstallation.model').deleteMany({ user_id: userId }, { session });
    const GroupRide = require('../models/GroupRide');
    await GroupRide.deleteMany({ owner: userId }, { session });
    await GroupRide.updateMany({ 'members.userId': userId },
      { $pull: { members: { userId } } }, { session });
    const { AssistPresence, AssistanceRequest } = require('../models/Assistance');
    await AssistPresence.deleteOne({ user: userId }, { session });
    const assistRequests = await AssistanceRequest.find({ $or: [
      { requester: userId }, { acceptedHelper: userId }, { 'offers.helper': userId },
    ] }).distinct('_id').session(session);
    await AssistanceRequest.deleteMany({ _id: { $in: assistRequests } }, { session });
    const CommunityRide = require('../models/CommunityRide');
    await CommunityRide.deleteMany({ host: userId }, { session });
    await CommunityRide.updateMany({ $or: [{ participants: userId }, { 'requests.rider': userId }] },
      { $pull: { participants: userId, requests: { rider: userId } } }, { session });
    await require('../models/CommunityFlag').deleteMany({ $or: [
      { reporter: userId }, { subject: userId },
    ] }, { session });
    await require('../models/CommunityBlock').deleteMany({ $or: [
      { blocker: userId }, { blocked: userId },
    ] }, { session });
    const { Experience, Bookmark, Helpful, Report } = require('../models/Community');
    const posts = await Experience.find({ author: userId }).distinct('_id').session(session);
    const votes = await Helpful.find({ user: userId }).distinct('experience').session(session);
    await Experience.updateMany({ _id: { $in: votes }, helpfulCount: { $gt: 0 } },
      { $inc: { helpfulCount: -1 } }, { session });
    await Experience.deleteMany({ author: userId }, { session });
    for (const model of [Bookmark, Helpful]) {
      await model.deleteMany({ $or: [{ user: userId }, { experience: { $in: posts } }] }, { session });
    }
    await Report.deleteMany({ $or: [{ reporter: userId }, { experience: { $in: posts } }] }, { session });
    await require('../models/FirmwareHistory.model').updateMany(
      { initiated_by: userId }, { $set: { initiated_by: null } }, { session });
  });
  require('../security/session').disconnectUser(userId);
  // Model post-hooks run before transaction commit; invalidate again afterwards.
  await cache.invalidate(cacheGroups);
}

module.exports = { retireAccount, deletionError, cacheGroups };

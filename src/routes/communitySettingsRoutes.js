const { Router } = require('express');
const { z } = require('zod');
const { isObjectIdOrHexString } = require('mongoose');
const { protect } = require('../middlewares/authMiddleware');
const { userLimiter } = require('../security/rateLimiter');
const Api = require('../utils/apiResponse');
const User = require('../models/User');
const CommunityBlock = require('../models/CommunityBlock');

const router = Router();
const defaults = { rideInvitations: true, rideRequests: true, assistanceNearby: true, assistanceOffers: true };
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); }, protect, userLimiter,
  (req, res, next) => req.user.role === 'USER' && req.user.status === 'active' ? next() : Api.error(res, 'Active rider account required.', 403));

router.get('/notifications', async (req, res) => {
  const user = await User.findById(req.user._id).select('communityNotifications').lean();
  return Api.success(res, { ...defaults, ...(user?.communityNotifications || {}) });
});

router.put('/notifications', async (req, res) => {
  const parsed = z.object({
    rideInvitations: z.boolean(), rideRequests: z.boolean(),
    assistanceNearby: z.boolean(), assistanceOffers: z.boolean(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return Api.badRequest(res, 'Choose a valid community notification setting.');
  const result = await User.findOneAndUpdate({ _id: req.user._id, role: 'USER', status: 'active' },
    { $set: { communityNotifications: parsed.data } }, { new: true }).select('communityNotifications').lean();
  return result ? Api.success(res, { ...defaults, ...result.communityNotifications }) : Api.error(res, 'Account unavailable.', 404);
});

router.get('/blocks', async (req, res) => {
  const rows = await CommunityBlock.find({ blocker: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
  const users = await User.find({ _id: { $in: rows.map(row => row.blocked) }, role: 'USER' }).select('name avatar').lean();
  const byId = new Map(users.map(user => [String(user._id), user]));
  return Api.success(res, { items: rows.map(row => ({ id: String(row.blocked),
    name: byId.get(String(row.blocked))?.name || 'Unavailable rider',
    avatar: byId.get(String(row.blocked))?.avatar || null })) });
});

router.post('/blocks', async (req, res) => {
  const blockedId = req.body?.userId;
  if (!isObjectIdOrHexString(blockedId) || String(blockedId) === String(req.user._id)) return Api.badRequest(res, 'Choose another rider to block.');
  if (!await User.exists({ _id: blockedId, role: 'USER', status: 'active' })) return Api.error(res, 'Rider unavailable.', 404);
  await CommunityBlock.updateOne({ blocker: req.user._id, blocked: blockedId },
    { $setOnInsert: { blocker: req.user._id, blocked: blockedId } }, { upsert: true });
  return Api.success(res, { blocked: true });
});

router.delete('/blocks/:userId', async (req, res) => {
  if (!isObjectIdOrHexString(req.params.userId)) return Api.badRequest(res, 'Invalid rider.');
  await CommunityBlock.deleteOne({ blocker: req.user._id, blocked: req.params.userId });
  return Api.success(res, { blocked: false });
});

module.exports = router;

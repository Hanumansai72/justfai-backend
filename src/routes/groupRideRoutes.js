const express = require('express');
const { randomBytes } = require('node:crypto');
const { isObjectIdOrHexString } = require('mongoose');
const { protect } = require('../middlewares/authMiddleware');
const { userLimiter } = require('../security/rateLimiter');
const Api = require('../utils/apiResponse');
const GroupRide = require('../models/GroupRide');
const User = require('../models/User');
const { blockedRiderIds } = require('../services/communitySafety.service');

const router = express.Router();
const MAX_MEMBERS = 12;
const LIVE_MS = 45000;
const RIDE_MS = 8 * 60 * 60 * 1000;
const isPremium = user => user.role === 'USER' && user.premium_until > new Date();
const active = () => ({ expiresAt: { $gt: new Date() } });
const memberFilter = (req) => ({
  ...active(),
  _id: req.params.id,
  'members.userId': req.user._id,
});

async function snapshot(ride, viewer) {
  const now = new Date();
  const blocked = new Set(await blockedRiderIds(viewer));
  const accounts = await User.find({
    _id: { $in: ride.members.map(member => member.userId) },
    role: 'USER', status: { $in: ['active', null] },
    premium_until: { $gt: now },
  }).select('name').lean();
  const names = new Map(accounts.map(account => [String(account._id), account.name]));
  return {
    id: String(ride._id),
    code: ride.code,
    isHost: String(ride.owner) === String(viewer),
    expiresAt: ride.expiresAt,
    members: ride.members.flatMap(member => {
      const id = String(member.userId);
      if (!names.has(id) || blocked.has(id)) return [];
      const point = member.location;
      return [{
        id,
        name: names.get(id),
        isYou: id === String(viewer),
        lastLocationUpdatedAt: point?.updatedAt ?? null,
        location: point?.updatedAt && now - point.updatedAt < LIVE_MS ? point : null,
      }];
    }),
  };
}

router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
}, protect, userLimiter);

router.get('/subscription', (req, res) => Api.success(res, {
  premium: isPremium(req.user),
  premiumUntil: req.user.premium_until ?? null,
}));

router.param('id', (req, res, next, id) =>
  isObjectIdOrHexString(id) ? next() : Api.badRequest(res, 'Invalid group ride.'));

// Riders can leave an existing group even if their entitlement has ended.
router.delete('/:id', async (req, res) => {
  const filter = memberFilter(req);
  const closed = await GroupRide.deleteOne({ ...filter, owner: req.user._id });
  if (!closed.deletedCount) {
    await GroupRide.updateOne(filter, { $pull: { members: { userId: req.user._id } } });
  }
  return Api.success(res);
});

router.use((req, res, next) => isPremium(req.user)
  ? next() : Api.error(res, 'Group Ride requires active Premium access.', 403));

router.get('/current', async (req, res) => {
  const ride = await GroupRide.findOne({ ...active(), 'members.userId': req.user._id }).lean();
  return Api.success(res, ride ? await snapshot(ride, req.user._id) : null);
});

// TTL removal is asynchronous. Release expired memberships before joining or creating.
const clearExpired = userId => GroupRide.deleteMany({
  expiresAt: { $lte: new Date() }, 'members.userId': userId,
});

router.post('/', async (req, res) => {
  await clearExpired(req.user._id);
  let ride;
  try {
    ride = await GroupRide.create({
      owner: req.user._id,
      code: randomBytes(6).toString('hex').toUpperCase(),
      expiresAt: new Date(Date.now() + RIDE_MS),
      members: [{ userId: req.user._id }],
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Api.error(res, 'You already have a group ride, or the invite could not be created.', 409);
  }
  return Api.created(res, await snapshot(ride.toObject(), req.user._id));
});

router.post('/join', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  if (!/^[0-9A-F]{12}$/.test(code)) return Api.badRequest(res, 'Enter the 12-character invite code.');
  await clearExpired(req.user._id);
  const current = await GroupRide.findOne({ ...active(), 'members.userId': req.user._id }).lean();
  if (current) {
    if (current.code !== code) return Api.error(res, 'Leave your current group first.', 409);
    return Api.success(res, await snapshot(current, req.user._id));
  }

  let ride;
  try {
    ride = await GroupRide.findOneAndUpdate({
      ...active(), code, 'members.userId': { $ne: req.user._id },
      ['members.' + (MAX_MEMBERS - 1)]: { $exists: false },
    }, { $push: { members: { userId: req.user._id } } }, { new: true }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Api.error(res, 'Leave your current group first.', 409);
  }
  if (!ride) return Api.error(res, 'Group ride is full, expired, or unavailable.', 404);
  return Api.success(res, await snapshot(ride, req.user._id));
});

router.put('/:id/location', async (req, res) => {
  const location = req.body?.location;
  if (location !== null && (!Number.isFinite(location?.lat) ||
      !Number.isFinite(location?.lng) || Math.abs(location.lat) > 90 ||
      Math.abs(location.lng) > 180)) {
    return Api.badRequest(res, 'Provide valid coordinates or stop sharing.');
  }
  const update = location === null
    ? { $unset: { 'members.$.location': 1 } }
    : { $set: { 'members.$.location': {
      lat: location.lat, lng: location.lng, updatedAt: new Date(),
    } } };
  const ride = await GroupRide.findOneAndUpdate(memberFilter(req), update, { new: true }).lean();
  if (!ride) return Api.error(res, 'Group ride is no longer available.', 404);
  return Api.success(res, await snapshot(ride, req.user._id));
});

module.exports = router;

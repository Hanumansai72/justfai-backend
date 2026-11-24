const { Router } = require('express');
const { isObjectIdOrHexString } = require('mongoose');
const { z } = require('zod');
const { protect } = require('../middlewares/authMiddleware');
const { userLimiter } = require('../security/rateLimiter');
const Api = require('../utils/apiResponse');
const CommunityRide = require('../models/CommunityRide');
const CommunityFlag = require('../models/CommunityFlag');
const User = require('../models/User');
const { sendCommunityNotification } = require('../services/communityNotification.service');
const { blockedRiderIds } = require('../services/communitySafety.service');

const router = Router();
const limit = 12;
const place = z.string().trim().min(2).max(100).refine(value => !value.includes('://') && !/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(value));
const input = z.object({
  title: z.string().trim().min(3).max(100), origin: place, destination: place,
  departureAt: z.iso.datetime().transform(value => new Date(value)),
  returnAt: z.iso.datetime().transform(value => new Date(value)).optional(),
  meetingPoint: z.string().trim().max(120).optional(),
  capacity: z.number().int().min(2).max(15),
  pace: z.enum(['relaxed', 'steady', 'brisk']),
  experienceLevel: z.enum(['any', 'beginner', 'intermediate', 'experienced']).default('any'),
  budget: z.number().int().min(0).max(10000000).optional(),
  description: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'private']).default('public'),
}).strict();
const oid = id => isObjectIdOrHexString(id);
const safe = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
const activeUser = (req, res, next) => req.user.role === 'USER' && req.user.status === 'active'
  ? next() : Api.error(res, 'Active rider account required.', 403);
const pageOf = req => Math.max(1, Math.min(5000, parseInt(req.query.page, 10) || 1));
const member = (ride, user) => String(ride.host) === String(user) || ride.participants.some(id => String(id) === String(user));
const eligible = ride => ride.state === 'planned' && ride.departureAt > new Date();

async function present(rows, viewer, { includePending = false } = {}) {
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap(row => [row.host, ...row.participants,
    ...(includePending ? row.requests.filter(r => r.state === 'pending').map(r => r.rider) : [])]))];
  const users = await User.find({ _id: { $in: ids }, role: 'USER', status: 'active' }).select('name avatar').lean();
  const byId = new Map(users.map(user => [String(user._id), { id: String(user._id), name: user.name, avatar: user.avatar || null }]));
  return rows.map(row => ({
    id: String(row._id), title: row.title, origin: row.origin, destination: row.destination,
    departureAt: row.departureAt, returnAt: row.returnAt, meetingPoint: row.meetingPoint,
    capacity: row.capacity, pace: row.pace, experienceLevel: row.experienceLevel,
    budget: row.budget, description: row.description, visibility: row.visibility,
    state: row.state, isHost: String(row.host) === String(viewer),
    isMember: member(row, viewer),
    host: byId.get(String(row.host)) || { id: String(row.host), name: 'Rider' },
    participants: row.participants.map(id => byId.get(String(id))).filter(Boolean),
    slotsLeft: Math.max(0, row.capacity - row.participants.length),
    myRequest: row.requests.find(item => String(item.rider) === String(viewer))?.state || null,
    requests: String(row.host) === String(viewer) ? row.requests.filter(item => item.state === 'pending').map(item => ({
      id: String(item._id), rider: byId.get(String(item.rider)) || { id: String(item.rider), name: 'Rider' }, kind: item.kind,
    })) : undefined,
  }));
}

router.use(safe, protect, userLimiter, activeUser);
router.param('id', (req, res, next, id) => oid(id) ? next() : Api.badRequest(res, 'Invalid ride ID.'));
router.param('requestId', (req, res, next, id) => oid(id) ? next() : Api.badRequest(res, 'Invalid join request.'));

router.get('/', async (req, res) => {
  const page = pageOf(req);
  const blocked = await blockedRiderIds(req.user._id);
  const filters = { visibility: 'public', state: 'planned', departureAt: { $gte: new Date() },
    host: { $nin: blocked }, participants: { $nin: blocked } };
  if (typeof req.query.destination === 'string' && req.query.destination.trim()) filters.destination = new RegExp(req.query.destination.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = await CommunityRide.find(filters).sort({ departureAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit + 1).lean();
  return Api.success(res, { items: await present(rows.slice(0, limit), req.user._id), nextPage: rows.length > limit ? page + 1 : null });
});

router.get('/mine', async (req, res) => {
  const rows = await CommunityRide.find({ $or: [{ host: req.user._id }, { participants: req.user._id }] })
    .sort({ departureAt: 1, _id: 1 }).limit(30).lean();
  return Api.success(res, { items: await present(rows, req.user._id, { includePending: true }) });
});

router.get('/invitations', async (req, res) => {
  const rows = await CommunityRide.find({ visibility: 'private', state: 'planned', departureAt: { $gt: new Date() },
    requests: { $elemMatch: { rider: req.user._id, kind: 'invite', state: 'pending' } } }).sort({ departureAt: 1 }).limit(30).lean();
  return Api.success(res, { items: await present(rows, req.user._id) });
});

// Lightweight, explainable match: same destination label and departure within 24 hours.
router.get('/matches', async (req, res) => {
  const destination = typeof req.query.destination === 'string' ? req.query.destination.trim() : '';
  const departureAt = new Date(String(req.query.departureAt || ''));
  if (destination.length < 2 || !Number.isFinite(departureAt.getTime())) return Api.badRequest(res, 'Provide a destination and planned departure date.');
  const start = new Date(departureAt.getTime() - 12 * 60 * 60 * 1000);
  const end = new Date(departureAt.getTime() + 12 * 60 * 60 * 1000);
  const blocked = await blockedRiderIds(req.user._id);
  const rows = await CommunityRide.find({ visibility: 'public', state: 'planned', departureAt: { $gte: start, $lte: end },
    destination: new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), host: { $ne: req.user._id, $nin: blocked }, participants: { $nin: blocked } })
    .sort({ departureAt: 1 }).limit(20).lean();
  return Api.success(res, { items: await present(rows, req.user._id), reason: 'Same destination label and departure within 12 hours.' });
});

router.post('/', async (req, res) => {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) return Api.badRequest(res, 'Check the ride details.');
  if (parsed.data.departureAt <= new Date() || parsed.data.departureAt > new Date(Date.now() + 180 * 86400000)) return Api.badRequest(res, 'Choose a departure within the next 180 days.');
  if (parsed.data.returnAt && (parsed.data.returnAt <= parsed.data.departureAt || parsed.data.returnAt > new Date(parsed.data.departureAt.getTime() + 30 * 86400000))) return Api.badRequest(res, 'Return must follow departure and be within 30 days.');
  const ride = await CommunityRide.create({ ...parsed.data, host: req.user._id, participants: [req.user._id] });
  return Api.created(res, (await present([ride.toObject()], req.user._id))[0]);
});

router.get('/:id', async (req, res) => {
  const ride = await CommunityRide.findById(req.params.id).lean();
  const blocked = await blockedRiderIds(req.user._id);
  if (!ride || (ride.visibility === 'private' && !member(ride, req.user._id) &&
      !ride.requests.some(item => String(item.rider) === String(req.user._id) && item.kind === 'invite' && item.state === 'pending')) ||
      blocked.includes(String(ride.host))) return Api.error(res, 'Ride unavailable.', 404);
  return Api.success(res, (await present([ride], req.user._id, { includePending: true }))[0]);
});

router.post('/:id/report', async (req, res) => {
  const reason = z.string().trim().min(3).max(500).safeParse(req.body?.reason);
  if (!reason.success) return Api.badRequest(res, 'Enter a reason for this report.');
  const ride = await CommunityRide.findById(req.params.id).select('host visibility participants requests').lean();
  if (!ride || (ride.visibility === 'private' && !member(ride, req.user._id))) return Api.error(res, 'Ride unavailable.', 404);
  if (String(ride.host) === String(req.user._id)) return Api.badRequest(res, 'You cannot report your own ride.');
  try { await CommunityFlag.create({ reporter: req.user._id, subjectType: 'ride', subject: ride._id, reason: reason.data }); }
  catch (error) { if (error.code !== 11000) throw error; }
  return Api.success(res);
});

router.post('/:id/join', async (req, res) => {
  const rideBeforeJoin = await CommunityRide.findById(req.params.id).select('host participants').lean();
  if (!rideBeforeJoin) return Api.error(res, 'Ride unavailable.', 404);
  const blocked = await blockedRiderIds(req.user._id);
  if ([rideBeforeJoin.host, ...rideBeforeJoin.participants].some(id => blocked.includes(String(id)))) return Api.error(res, 'You cannot join a ride with a blocked rider.', 403);
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, visibility: 'public', state: 'planned', departureAt: { $gt: new Date() },
    participants: { $ne: req.user._id }, requests: { $not: { $elemMatch: { rider: req.user._id, state: 'pending' } } },
    $expr: { $lt: [{ $size: '$participants' }, '$capacity'] } },
  { $push: { requests: { rider: req.user._id, kind: 'join', state: 'pending' } } }, { new: true }).lean();
  if (!ride) return Api.error(res, 'Ride unavailable, full, or you already have a request.', 409);
  await sendCommunityNotification({ user_id: ride.host, type: 'RIDE_JOIN_REQUEST', title: 'Rider wants to join your ride',
    message: 'Open Ride Together to review the request.', data: { rideId: String(ride._id) } }).catch(() => {});
  return Api.success(res, (await present([ride], req.user._id))[0]);
});

router.post('/:id/invite', async (req, res) => {
  let invitee;
  const riderId = req.body?.riderId;
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
  if (oid(riderId)) invitee = await User.findOne({ _id: riderId, role: 'USER', status: 'active' }).select('_id').lean();
  else if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(identifier) || /^[a-z0-9_.-]{3,30}$/.test(identifier)) {
    invitee = await User.findOne({ role: 'USER', status: 'active', $or: [{ email: identifier }, { username: identifier }] }).select('_id').lean();
  }
  if (invitee && String(invitee._id) === String(req.user._id)) return Api.badRequest(res, 'You cannot invite yourself.');
  if (!invitee) return Api.error(res, 'Rider unavailable.', 404);
  const targetId = invitee._id;
  const hostBlocked = await blockedRiderIds(req.user._id);
  const inviteeBlocked = await blockedRiderIds(targetId);
  if (hostBlocked.includes(String(targetId)) || inviteeBlocked.includes(String(req.user._id))) return Api.error(res, 'That rider is unavailable for this invite.', 404);
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, host: req.user._id, visibility: 'private', state: 'planned', departureAt: { $gt: new Date() },
    participants: { $ne: targetId }, requests: { $not: { $elemMatch: { rider: targetId, state: 'pending' } } },
    $expr: { $lt: [{ $size: '$participants' }, '$capacity'] } },
  { $push: { requests: { rider: targetId, kind: 'invite', state: 'pending' } } }, { new: true }).lean();
  if (!ride) return Api.error(res, 'Private ride unavailable or rider already invited.', 409);
  await sendCommunityNotification({ user_id: targetId, type: 'RIDE_INVITATION', title: 'You are invited to a ride',
    message: `${ride.title} · ${ride.origin} to ${ride.destination}`, data: { rideId: String(ride._id) } }).catch(() => {});
  return Api.success(res, (await present([ride], req.user._id, { includePending: true }))[0]);
});

router.patch('/:id/requests/:requestId', async (req, res) => {
  const action = req.body?.action;
  if (!['accept', 'reject'].includes(action)) return Api.badRequest(res, 'Choose accept or reject.');
  const pre = await CommunityRide.findOne({ _id: req.params.id, host: req.user._id, state: 'planned',
    requests: { $elemMatch: { _id: req.params.requestId, state: 'pending' } } }).select('requests.$').lean();
  const pending = pre?.requests?.[0];
  if (!pending) return Api.error(res, 'Request unavailable.', 404);
  const query = { _id: req.params.id, host: req.user._id, state: 'planned', departureAt: { $gt: new Date() },
    requests: { $elemMatch: { _id: req.params.requestId, rider: pending.rider, state: 'pending' } } };
  if (action === 'accept') Object.assign(query, { $expr: { $lt: [{ $size: '$participants' }, '$capacity'] } });
  const update = action === 'accept'
    ? { $addToSet: { participants: pending.rider }, $set: { 'requests.$.state': 'accepted' } }
    : { $set: { 'requests.$.state': 'rejected' } };
  const ride = await CommunityRide.findOneAndUpdate(query, update, { new: true }).lean();
  if (!ride) return Api.error(res, 'Ride is full or request already handled.', 409);
  if (action === 'accept') await sendCommunityNotification({ user_id: pending.rider, type: 'RIDE_JOIN_ACCEPTED', title: 'Your ride request was accepted', message: ride.title, data: { rideId: String(ride._id) } }).catch(() => {});
  return Api.success(res, (await present([ride], req.user._id, { includePending: true }))[0]);
});

router.delete('/:id/requests/:requestId', async (req, res) => {
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, host: req.user._id,
    requests: { $elemMatch: { _id: req.params.requestId, state: 'pending' } } },
  { $set: { 'requests.$.state': 'cancelled' } }, { new: true }).lean();
  return ride ? Api.success(res, (await present([ride], req.user._id, { includePending: true }))[0]) : Api.error(res, 'Request unavailable.', 404);
});

router.post('/invitations/:id/respond', async (req, res) => {
  const action = req.body?.action;
  if (!['accept', 'decline'].includes(action)) return Api.badRequest(res, 'Choose accept or decline.');
  const query = { _id: req.params.id, visibility: 'private', state: 'planned', departureAt: { $gt: new Date() },
    requests: { $elemMatch: { rider: req.user._id, kind: 'invite', state: 'pending' } } };
  if (action === 'accept') Object.assign(query, { $expr: { $lt: [{ $size: '$participants' }, '$capacity'] } });
  const update = action === 'accept'
    ? { $addToSet: { participants: req.user._id }, $set: { 'requests.$.state': 'accepted' } }
    : { $set: { 'requests.$.state': 'rejected' } };
  const ride = await CommunityRide.findOneAndUpdate(query, update, { new: true }).lean();
  return ride ? Api.success(res, (await present([ride], req.user._id))[0]) : Api.error(res, 'Invitation expired or ride is full.', 409);
});

router.delete('/:id/participants/me', async (req, res) => {
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, state: 'planned', host: { $ne: req.user._id }, participants: req.user._id },
    { $pull: { participants: req.user._id }, $set: { 'requests.$[item].state': 'cancelled' } },
    { new: true, arrayFilters: [{ 'item.rider': req.user._id, 'item.state': 'accepted' }] }).lean();
  return ride ? Api.success(res, (await present([ride], req.user._id))[0]) : Api.error(res, 'Ride unavailable.', 404);
});

router.delete('/:id/requests/me', async (req, res) => {
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, state: 'planned',
    requests: { $elemMatch: { rider: req.user._id, kind: 'join', state: 'pending' } } },
  { $set: { 'requests.$.state': 'cancelled' } }, { new: true }).lean();
  return ride ? Api.success(res, (await present([ride], req.user._id))[0]) : Api.error(res, 'Pending request unavailable.', 404);
});

router.delete('/:id/participants/:riderId', async (req, res) => {
  if (!oid(req.params.riderId)) return Api.badRequest(res, 'Invalid rider.');
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, host: req.user._id,
    state: 'planned', participants: req.params.riderId },
  { $pull: { participants: req.params.riderId }, $set: { 'requests.$[item].state': 'cancelled' } },
  { new: true, arrayFilters: [{ 'item.rider': req.params.riderId, 'item.state': 'accepted' }] }).lean();
  return ride ? Api.success(res, (await present([ride], req.user._id))[0]) : Api.error(res, 'Ride member unavailable.', 404);
});

router.patch('/:id/state', async (req, res) => {
  const state = req.body?.state;
  if (!['cancelled', 'completed'].includes(state)) return Api.badRequest(res, 'Invalid ride status.');
  const ride = await CommunityRide.findOneAndUpdate({ _id: req.params.id, host: req.user._id, state: 'planned',
    ...(state === 'completed' ? { departureAt: { $lte: new Date() } } : {}) }, { $set: { state } }, { new: true }).lean();
  return ride ? Api.success(res, (await present([ride], req.user._id))[0]) : Api.error(res, 'Ride unavailable.', 404);
});

module.exports = router;

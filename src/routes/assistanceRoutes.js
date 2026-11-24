const { Router } = require('express');
const { isObjectIdOrHexString, Types } = require('mongoose');
const { z } = require('zod');
const { protect } = require('../middlewares/authMiddleware');
const { userLimiter } = require('../security/rateLimiter');
const Api = require('../utils/apiResponse');
const User = require('../models/User');
const { AssistPresence, AssistanceRequest } = require('../models/Assistance');
const CommunityFlag = require('../models/CommunityFlag');
const { sendCommunityNotification } = require('../services/communityNotification.service');
const { blockedRiderIds } = require('../services/communitySafety.service');

const router = Router();
const maxAge = 15 * 60 * 1000;
const radius = 30000;
const types = ['fuel', 'puncture', 'breakdown', 'battery', 'ev_battery', 'lost', 'mechanic', 'towing', 'accident', 'other'];
const coordinate = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
const point = value => ({ type: 'Point', coordinates: [value.lng, value.lat] });
const validPoint = value => coordinate.safeParse(value);
const own = (req, id) => ({ _id: id, requester: req.user._id });
const publicRequest = (row, { precise = false, requester = false } = {}) => ({
  id: String(row._id), type: row.type, description: row.description,
  motorcycle: row.motorcycle, state: row.state, createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  ...(row.distanceMeters != null ? { approximateDistanceKm: Math.round(row.distanceMeters / 500) / 2 } : {}),
  location: precise && row.location?.coordinates?.length === 2 && row.expiresAt > new Date()
    ? { lat: row.location.coordinates[1], lng: row.location.coordinates[0] } : null,
  offers: requester ? row.offers.map(offer => ({ id: String(offer._id), helperId: String(offer.helper), state: offer.state, message: offer.message })) : undefined,
  acceptedHelper: row.acceptedHelper ? String(row.acceptedHelper) : null,
});
const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
router.use(noStore, protect, userLimiter, (req, res, next) =>
  req.user.role === 'USER' && req.user.status === 'active'
    ? next() : Api.error(res, 'Active rider account required.', 403));
router.param('id', (req, res, next, id) =>
  isObjectIdOrHexString(id) ? next() : Api.badRequest(res, 'Invalid assistance request.'));

// Location is stored only while the opt-in presence record is fresh (15 minutes).
router.get('/presence', async (req, res) => {
  const presence = await AssistPresence.findOne({ user: req.user._id, updatedAt: { $gt: new Date(Date.now() - maxAge) } }).select('_id updatedAt').lean();
  return Api.success(res, { enabled: Boolean(presence), expiresAt: presence?.updatedAt ? new Date(presence.updatedAt.getTime() + maxAge) : null });
});

router.put('/presence', async (req, res) => {
  if (req.body?.enabled === false) {
    await AssistPresence.deleteOne({ user: req.user._id });
    return Api.success(res, { enabled: false });
  }
  const parsed = validPoint(req.body?.location);
  if (!parsed.success) return Api.badRequest(res, 'Provide a valid location to opt in.');
  await AssistPresence.updateOne({ user: req.user._id }, {
    $set: { user: req.user._id, location: point(parsed.data), updatedAt: new Date() },
  }, { upsert: true });
  return Api.success(res, { enabled: true, expiresInSeconds: 900 });
});

router.get('/nearby', async (req, res) => {
  const presence = await AssistPresence.findOne({ user: req.user._id, updatedAt: { $gt: new Date(Date.now() - maxAge) } }).lean();
  if (!presence) return Api.error(res, 'Opt in and refresh your location to see nearby requests.', 409);
  const blocked = await blockedRiderIds(req.user._id);
  const rows = await AssistanceRequest.aggregate([
    { $geoNear: { near: presence.location, key: 'location', distanceField: 'distanceMeters',
      maxDistance: radius, spherical: true,
      query: { state: 'open', expiresAt: { $gt: new Date() }, requester: { $ne: req.user._id, $nin: blocked.map(id => new Types.ObjectId(id)) } } } },
    { $project: { type: 1, description: 1, motorcycle: 1, state: 1, createdAt: 1, expiresAt: 1, distanceMeters: 1 } },
    { $limit: 20 },
  ]);
  return Api.success(res, { items: rows.map(row => publicRequest(row)) });
});

router.post('/requests', async (req, res) => {
  const schema = z.object({ type: z.enum(types), location: coordinate,
    description: z.string().trim().max(500).optional(), motorcycle: z.string().trim().max(80).optional() }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return Api.badRequest(res, 'Check the assistance details and location.');
  await AssistanceRequest.updateMany({ requester: req.user._id, state: { $in: ['open', 'assigned'] }, expiresAt: { $lte: new Date() } },
    { $set: { state: 'expired' }, $unset: { activeForUser: '' } });
  let row;
  try {
    row = await AssistanceRequest.create({ requester: req.user._id, activeForUser: req.user._id,
      type: parsed.data.type, location: point(parsed.data.location),
      description: parsed.data.description || '', motorcycle: parsed.data.motorcycle || '',
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      purgeAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  } catch (error) {
    if (error.code === 11000) return Api.error(res, 'You already have an active assistance request.', 409);
    throw error;
  }
  const helpers = await AssistPresence.find({ updatedAt: { $gt: new Date(Date.now() - maxAge) },
    user: { $ne: req.user._id }, location: { $near: { $geometry: row.location, $maxDistance: radius } } })
    .select('user').limit(25).lean();
  const blocked = await blockedRiderIds(req.user._id);
  const eligible = await User.find({ _id: { $in: helpers.map(item => item.user), $nin: blocked }, role: 'USER', status: 'active' }).select('_id communityNotifications').lean();
  await Promise.allSettled(eligible.map(helper => sendCommunityNotification({ _user: helper, user_id: helper._id,
    type: 'ASSISTANCE_REQUEST', title: 'Rider nearby needs help',
    message: `A rider nearby needs help with ${row.type.replaceAll('_', ' ')}.`,
    data: { assistanceId: String(row._id) } })));
  return Api.created(res, publicRequest(row, { precise: true, requester: true }));
});

router.get('/mine', async (req, res) => {
  await AssistanceRequest.updateMany({ requester: req.user._id, state: { $in: ['open', 'assigned'] }, expiresAt: { $lte: new Date() } },
    { $set: { state: 'expired' }, $unset: { activeForUser: '', location: '' } });
  const rows = await AssistanceRequest.find({ requester: req.user._id }).sort({ createdAt: -1 }).limit(30).lean();
  return Api.success(res, { items: rows.map(row => publicRequest(row, { precise: true, requester: true })) });
});

router.get('/helping', async (req, res) => {
  const blocked = await blockedRiderIds(req.user._id);
  const rows = await AssistanceRequest.find({ acceptedHelper: req.user._id, requester: { $nin: blocked }, state: 'assigned', expiresAt: { $gt: new Date() } })
    .sort({ updatedAt: -1 }).limit(10).lean();
  return Api.success(res, { items: rows.map(row => publicRequest(row, { precise: true })) });
});

router.get('/requests/:id', async (req, res) => {
  const row = await AssistanceRequest.findOne({ _id: req.params.id,
    $or: [{ requester: req.user._id }, { acceptedHelper: req.user._id }] }).lean();
  if (!row) return Api.error(res, 'Assistance request unavailable.', 404);
  const blocked = await blockedRiderIds(req.user._id);
  if (blocked.includes(String(row.requester)) || (row.acceptedHelper && blocked.includes(String(row.acceptedHelper)))) return Api.error(res, 'Assistance request unavailable.', 404);
  return Api.success(res, publicRequest(row, {
    precise: true, requester: String(row.requester) === String(req.user._id),
  }));
});

router.post('/requests/:id/report', async (req, res) => {
  const reason = z.string().trim().min(3).max(500).safeParse(req.body?.reason);
  if (!reason.success) return Api.badRequest(res, 'Enter a reason for this report.');
  const row = await AssistanceRequest.findById(req.params.id).select('requester acceptedHelper state').lean();
  if (!row || !['open', 'assigned'].includes(row.state)) return Api.error(res, 'Assistance request unavailable.', 404);
  const subject = String(row.requester) === String(req.user._id) ? row.acceptedHelper : row.requester;
  if (!subject || String(subject) === String(req.user._id)) return Api.badRequest(res, 'There is no other rider to report yet.');
  try { await CommunityFlag.create({ reporter: req.user._id, subjectType: 'assistance', subject, context: row._id, reason: reason.data }); }
  catch (error) { if (error.code !== 11000) throw error; }
  return Api.success(res);
});

router.post('/requests/:id/offers', async (req, res) => {
  const request = await AssistanceRequest.findOne({ _id: req.params.id, state: 'open', expiresAt: { $gt: new Date() }, requester: { $ne: req.user._id } }).lean();
  if (!request) return Api.error(res, 'This request is no longer available.', 404);
  const blocked = await blockedRiderIds(req.user._id);
  if (blocked.includes(String(request.requester))) return Api.error(res, 'This request is no longer available.', 404);
  const present = await AssistPresence.exists({ user: req.user._id, updatedAt: { $gt: new Date(Date.now() - maxAge) },
    location: { $near: { $geometry: request.location, $maxDistance: radius } } });
  if (!present) return Api.error(res, 'Opt in with a recent location before offering help nearby.', 403);
  const message = z.string().trim().max(300).optional().safeParse(req.body?.message);
  if (!message.success) return Api.badRequest(res, 'Offer message is too long.');
  const updated = await AssistanceRequest.findOneAndUpdate({ _id: req.params.id, state: 'open', expiresAt: { $gt: new Date() }, 'offers.helper': { $ne: req.user._id } },
    { $push: { offers: { helper: req.user._id, message: message.data || '' } } }, { new: true }).lean();
  if (!updated) return Api.error(res, 'You already offered help or the request has closed.', 409);
  await sendCommunityNotification({ user_id: updated.requester, type: 'ASSISTANCE_OFFER', title: 'A rider offered help',
    message: 'Open Rider Assist to review the offer.', data: { assistanceId: String(updated._id) } }).catch(() => {});
  return Api.success(res, { offered: true });
});

router.patch('/requests/:id/offers/:offerId', async (req, res) => {
  if (!isObjectIdOrHexString(req.params.offerId)) return Api.badRequest(res, 'Invalid assistance offer.');
  const action = req.body?.action;
  if (!['accept', 'decline'].includes(action)) return Api.badRequest(res, 'Choose accept or decline.');
  if (action === 'decline') {
    const result = await AssistanceRequest.updateOne({ ...own(req, req.params.id), state: 'open', 'offers._id': req.params.offerId },
      { $set: { 'offers.$.state': 'declined' } });
    return result.modifiedCount ? Api.success(res) : Api.error(res, 'Offer unavailable.', 404);
  }
  const request = await AssistanceRequest.findOne({ ...own(req, req.params.id), state: 'open',
    offers: { $elemMatch: { _id: req.params.offerId, state: 'pending' } } },
    ).select('offers.$').lean();
  if (!request?.offers?.[0]) return Api.error(res, 'Offer already accepted or unavailable.', 409);
  const helper = request.offers[0].helper;
  const blocked = await blockedRiderIds(req.user._id);
  if (blocked.includes(String(helper))) return Api.error(res, 'This offer is no longer available.', 404);
  const result = await AssistanceRequest.findOneAndUpdate({ ...own(req, req.params.id), state: 'open',
    offers: { $elemMatch: { _id: req.params.offerId, helper, state: 'pending' } } },
  { $set: { state: 'assigned', acceptedHelper: helper, 'offers.$[chosen].state': 'accepted' } },
  { new: true, arrayFilters: [{ 'chosen._id': req.params.offerId }] }).lean();
  if (!result) return Api.error(res, 'Offer already accepted or unavailable.', 409);
  await sendCommunityNotification({ user_id: helper, type: 'ASSISTANCE_ACCEPTED', title: 'Your help was accepted',
    message: 'The rider accepted your offer. Open Rider Assist for the meeting location.', data: { assistanceId: String(result._id) } }).catch(() => {});
  return Api.success(res, publicRequest(result, { precise: true, requester: true }));
});

router.patch('/requests/:id/status', async (req, res) => {
  const action = req.body?.action;
  if (!['resolve', 'cancel'].includes(action)) return Api.badRequest(res, 'Choose resolve or cancel.');
  const filter = action === 'cancel' ? own(req, req.params.id) : { _id: req.params.id, acceptedHelper: req.user._id };
  const state = action === 'cancel' ? 'cancelled' : 'resolved';
  const row = await AssistanceRequest.findOneAndUpdate({ ...filter, state: { $in: ['open', 'assigned'] } },
    { $set: { state }, $unset: { activeForUser: '', location: '' } }, { new: true }).lean();
  return row ? Api.success(res, publicRequest(row, { precise: true, requester: String(row.requester) === String(req.user._id) }))
    : Api.error(res, 'Request unavailable.', 404);
});

module.exports = router;

const { Router } = require('express');
const { isObjectIdOrHexString, connection, Types } = require('mongoose');
const { z } = require('zod');
const Api = require('../utils/apiResponse');
const { protect, authorize } = require('../middlewares/authMiddleware');
const { userLimiter } = require('../security/rateLimiter');
const { Experience, Bookmark, Helpful, Report } = require('../models/Community');
const Ride = require('../models/Ride.model');
const User = require('../models/User');
const audit = require('../security/auditLogger');
const CommunityFlag = require('../models/CommunityFlag');
const CommunityRide = require('../models/CommunityRide');
const { AssistanceRequest } = require('../models/Assistance');
const { blockedRiderIds } = require('../services/communitySafety.service');
const escapeRegex = require('../utils/escapeRegex');

const router = Router();
const moderation = Router();
const publicState = { state: 'published' };
const categories = ['Fuel', 'Accommodation', 'Food', 'Tolls', 'Maintenance', 'Activities', 'Other'];
const text = max => z.string().trim().max(max);
const publicPlace = text(100).refine(value => !value.includes('://') &&
  !/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(value));
const amount = z.number().int().min(0).max(10000000);
const input = z.object({
  title: text(100), origin: publicPlace, destination: publicPlace,
  region: text(100).optional(), motorcycle: text(80).optional(),
  story: text(5000), roadNotes: text(2000).optional(),
  season: text(40).optional(), travelledOn: z.iso.date().optional(),
  distanceKm: z.number().min(0).max(100000).optional(),
  durationMinutes: z.number().int().min(0).max(525600).optional(),
  hotel: text(160).optional(), hotelCost: amount.optional(),
  hotelParking: text(350).optional(),
  expenses: z.array(z.object({ category: z.enum(categories), amount }).strict()).max(20).optional(),
  publish: z.boolean(),
  sourceSessionId: text(100).optional(),
}).strict().refine(value => !value.publish ||
  [value.title, value.origin, value.destination, value.story].every(Boolean));

const own = (req) => ({ _id: req.params.id, author: req.user._id, state: { $ne: 'removed' } });
const published = (id) => ({ _id: id, ...publicState });
const pageOf = (req) => Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
const limit = 12;
const missing = res => Api.error(res, 'Ride experience unavailable.', 404);
const safe = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
const validateId = (req, res, next, id) =>
  isObjectIdOrHexString(id) ? next() : Api.badRequest(res, 'Invalid record ID.');
router.use(safe, protect, authorize('USER'), userLimiter);
router.param('id', validateId);
moderation.use(safe);
moderation.param('id', validateId);

async function present(rows, viewer) {
  if (!rows.length) return [];
  const ids = rows.map(row => row._id);
  const [authors, saves, votes] = await Promise.all([
    User.find({ _id: { $in: rows.map(row => row.author) } }).select('name avatar').lean(),
    Bookmark.find({ user: viewer, experience: { $in: ids } }).select('experience').lean(),
    Helpful.find({ user: viewer, experience: { $in: ids } }).select('experience').lean(),
  ]);
  const names = new Map(authors.map(a => [String(a._id), a]));
  const saved = new Set(saves.map(row => String(row.experience)));
  const voted = new Set(votes.map(row => String(row.experience)));
  return rows.map(row => {
    const { _id, author, sourceRide, __v, ...fields } = row;
    const id = String(_id);
    const authorId = String(author);
    const profile = names.get(String(author));
    return { ...fields, id, authorId, authorName: profile?.name ?? 'JustRide rider',
      authorAvatar: profile?.avatar ?? null, isOwner: String(author) === String(viewer),
      linkedRide: Boolean(sourceRide), saved: saved.has(id), helpful: voted.has(id) };
  });
}

async function feed(req, res, filter, sort, projection) {
  const page = pageOf(req);
  const rows = await Experience.find(filter).select(projection).sort(sort)
    .skip((page - 1) * limit).limit(limit + 1).lean();
  return Api.success(res, { items: await present(rows.slice(0, limit), req.user._id),
    nextPage: rows.length > limit ? page + 1 : null });
}
const cardFields = 'author sourceRide state title origin destination region motorcycle ' +
  'distanceKm durationMinutes expenses helpfulCount publishedAt';

router.get('/experiences', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  const filter = { ...publicState, ...(q && { $text: { $search: q } }) };
  const blocked = await blockedRiderIds(req.user._id);
  if (blocked.length) filter.author = { $nin: blocked };
  for (const field of ['region', 'motorcycle', 'season']) {
    if (typeof req.query[field] === 'string' && req.query[field].trim()) {
      filter[field] = new RegExp('^' + escapeRegex(req.query[field].trim().slice(0, 100)) + '$', 'i');
    }
  }
  for (const field of ['distanceKm', 'durationMinutes']) {
    const value = req.query[field];
    if (typeof value === 'string' && /^\d{1,6}$/.test(value)) filter[field] = { $lte: Number(value) };
  }
  const budget = req.query.budget;
  if (typeof budget === 'string' && /^\d{1,8}$/.test(budget)) {
    filter['expenses.0'] = { $exists: true };
    filter.$expr = { $lte: [{ $sum: '$expenses.amount' }, Number(budget)] };
  }
  const recent = { publishedAt: -1, _id: -1 };
  const relevance = q && req.query.sort !== 'recent' && req.query.sort !== 'helpful';
  const sort = req.query.sort === 'helpful' ? { helpfulCount: -1, ...recent }
    : relevance ? { score: { $meta: 'textScore' }, ...recent } : recent;
  return feed(req, res, filter, sort, cardFields);
});
router.get('/mine', (req, res) => feed(req, res,
  { author: req.user._id, state: { $ne: 'removed' } }, { updatedAt: -1, _id: -1 }, cardFields));
router.get('/saved', async (req, res) => {
  const page = pageOf(req);
  const blocked = await blockedRiderIds(req.user._id);
  const rows = await Bookmark.aggregate([
    { $match: { user: req.user._id } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $lookup: { from: Experience.collection.name, localField: 'experience',
      foreignField: '_id', pipeline: [{ $match: publicState }], as: 'post' } },
    { $unwind: '$post' },
    ...(blocked.length ? [{ $match: { 'post.author': { $nin: blocked.map(id => new Types.ObjectId(id)) } } }] : []),
    { $skip: (page - 1) * limit }, { $limit: limit + 1 },
    { $replaceRoot: { newRoot: '$post' } },
    { $project: Object.fromEntries(cardFields.split(' ').map(field => [field, 1])) },
  ]);
  return Api.success(res, { items: await present(rows.slice(0, limit), req.user._id),
    nextPage: rows.length > limit ? page + 1 : null });
});
router.get('/experiences/:id', async (req, res) => {
  const row = await Experience.findOne({ _id: req.params.id,
    $or: [publicState, { author: req.user._id, state: 'draft' }] }).lean();
  if (row && row.state !== 'draft' && (await blockedRiderIds(req.user._id)).includes(String(row.author))) return missing(res);
  return row ? Api.success(res, (await present([row], req.user._id))[0]) : missing(res);
});

async function saveExperience(req, res, editing) {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) return Api.badRequest(res, 'Check the experience details and complete the required fields.');
  const { sourceSessionId, publish, ...fields } = parsed.data;
  const current = editing ? await Experience.findOne(own(req)).lean() : null;
  if (editing && !current) return missing(res);
  const source = sourceSessionId ? await Ride.findOne({ user_id: req.user._id,
    sessionId: sourceSessionId, status: 'completed' }).select('_id').lean() : null;
  if (sourceSessionId && !source) return Api.badRequest(res, 'That completed ride record is unavailable.');
  const state = publish ? 'published' : 'draft';
  const values = { ...fields, state, publishedAt: publish ? current?.publishedAt ?? new Date() : null };
  if (source) values.sourceRide = source._id;
  const unset = Object.fromEntries(['distanceKm', 'durationMinutes', 'travelledOn', 'hotelCost']
    .filter(field => fields[field] === undefined).map(field => [field, '']));
  const row = editing ? await Experience.findOneAndUpdate(own(req), { $set: values, $unset: unset },
    { new: true }).lean() : (await Experience.create({ ...values, author: req.user._id })).toObject();
  if (!row) return missing(res);
  return Api.success(res, (await present([row], req.user._id))[0], 'Experience saved', editing ? 200 : 201);
}
router.post('/experiences', (req, res) => saveExperience(req, res, false));
router.patch('/experiences/:id', (req, res) => saveExperience(req, res, true));
router.delete('/experiences/:id', async (req, res) => {
  await connection.transaction(async session => {
    const removed = await Experience.deleteOne({ _id: req.params.id, author: req.user._id }, { session });
    if (!removed.deletedCount) return;
    for (const model of [Bookmark, Helpful, Report]) {
      await model.deleteMany({ experience: req.params.id }, { session });
    }
  });
  return Api.success(res);
});

router.put('/experiences/:id/saved', async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return Api.badRequest(res);
  const filter = { user: req.user._id, experience: req.params.id };
  if (req.body.enabled) {
    if (!await Experience.exists(published(req.params.id))) return missing(res);
    await Bookmark.updateOne(filter, { $setOnInsert: filter }, { upsert: true });
  } else {
    await Bookmark.deleteOne(filter);
  }
  return Api.success(res);
});
router.put('/experiences/:id/helpful', async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return Api.badRequest(res);
  const found = await connection.transaction(async session => {
    const route = { ...published(req.params.id), author: { $ne: req.user._id } };
    if (!await Experience.exists(route).session(session)) return false;
    const filter = { user: req.user._id, experience: req.params.id };
    const delta = req.body.enabled
      ? (await Helpful.updateOne(filter, { $setOnInsert: filter }, { upsert: true, session })).upsertedCount
      : -(await Helpful.deleteOne(filter, { session })).deletedCount;
    if (delta) await Experience.updateOne(route, { $inc: { helpfulCount: delta } }, { session });
    return true;
  });
  return found ? Api.success(res) : missing(res);
});
router.post('/experiences/:id/report', async (req, res) => {
  const reason = text(500).min(3).safeParse(req.body?.reason);
  if (!reason.success) return Api.badRequest(res, 'Enter a reason for the report.');
  if (!await Experience.exists({ ...published(req.params.id), author: { $ne: req.user._id } })) return missing(res);
  const filter = { reporter: req.user._id, experience: req.params.id };
  await Report.updateOne(filter, { $setOnInsert: { ...filter, reason: reason.data } }, { upsert: true });
  return Api.success(res);
});

router.get('/profiles/:id', async (req, res) => {
  const rider = await User.findOne({ _id: req.params.id, role: 'USER', status: 'active' }).select('name avatar').lean();
  if (!rider) return Api.error(res, 'Rider unavailable.', 404);
  const [completedRideRecords, experiences, groupRides] = await Promise.all([
    Ride.countDocuments({ user_id: rider._id, status: 'completed' }),
    Experience.aggregate([{ $match: { author: rider._id, state: 'published' } },
      { $group: { _id: null, count: { $sum: 1 }, helpful: { $sum: '$helpfulCount' } } }]),
    CommunityRide.countDocuments({ host: rider._id, state: 'completed' }),
  ]);
  return Api.success(res, { id: String(rider._id), name: rider.name, avatar: rider.avatar || null,
    completedRideRecords, publishedExperiences: experiences[0]?.count || 0,
    helpfulRecommendations: experiences[0]?.helpful || 0, organizedRides: groupRides });
});

router.post('/profiles/:id/report', async (req, res) => {
  const reason = text(500).min(3).safeParse(req.body?.reason);
  if (!reason.success) return Api.badRequest(res, 'Enter a reason for this report.');
  if (String(req.params.id) === String(req.user._id)) return Api.badRequest(res, 'You cannot report your own profile.');
  if (!await User.exists({ _id: req.params.id, role: 'USER', status: 'active' })) return Api.error(res, 'Rider unavailable.', 404);
  try { await CommunityFlag.create({ reporter: req.user._id, subjectType: 'rider', subject: req.params.id, reason: reason.data }); }
  catch (error) { if (error.code !== 11000) throw error; }
  return Api.success(res);
});

moderation.get('/reports', async (req, res) => {
  const page = pageOf(req);
  const reports = await Report.find({ state: 'pending' }).sort({ createdAt: 1, _id: 1 })
    .skip((page - 1) * limit).limit(limit + 1).lean();
  const posts = await Experience.find({ ...publicState, _id: { $in: reports.map(report => report.experience) } })
    .select('title story state').lean();
  const byId = new Map(posts.map(post => [String(post._id), post]));
  return Api.success(res, { items: reports.slice(0, limit).map(report => ({
    id: report._id, reason: report.reason, createdAt: report.createdAt,
    experience: byId.get(String(report.experience)) ?? null,
  })), nextPage: reports.length > limit ? page + 1 : null });
});
moderation.patch('/reports/:id', async (req, res) => {
  const action = req.body?.action;
  if (action !== 'dismiss' && action !== 'remove') return Api.badRequest(res);
  const handled = await connection.transaction(async session => {
    const report = await Report.findOneAndUpdate({ _id: req.params.id, state: 'pending' },
      { $set: { state: action === 'remove' ? 'removed' : 'dismissed' } }, { session });
    if (!report) return false;
    if (action === 'remove') {
      await Experience.updateOne(published(report.experience), { $set: { state: 'removed' } }, { session });
      await Report.updateMany({ experience: report.experience, state: 'pending' },
        { $set: { state: 'removed' } }, { session });
    }
    return true;
  });
  if (!handled) return Api.error(res, 'Report already resolved or unavailable.', 404);
  audit.log({ req, category: 'ADMIN', action: 'COMMUNITY_REPORT_RESOLVED',
    resource_type: 'CommunityReport', resource_id: req.params.id, metadata: { action } });
  return Api.success(res);
});

moderation.get('/flags', async (req, res) => {
  const page = pageOf(req);
  const flags = await CommunityFlag.find({ state: 'pending' }).sort({ createdAt: 1, _id: 1 })
    .skip((page - 1) * limit).limit(limit + 1).lean();
  const pageFlags = flags.slice(0, limit);
  const [rides, assistance, riders] = await Promise.all([
    CommunityRide.find({ _id: { $in: pageFlags.filter(flag => flag.subjectType === 'ride').map(flag => flag.subject) } }).select('title origin destination state').lean(),
    AssistanceRequest.find({ _id: { $in: pageFlags.filter(flag => flag.subjectType === 'assistance').map(flag => flag.context) } }).select('type description state').lean(),
    User.find({ _id: { $in: pageFlags.filter(flag => flag.subjectType === 'rider').map(flag => flag.subject) } }).select('name status').lean(),
  ]);
  const index = rows => new Map(rows.map(row => [String(row._id), row]));
  const byRide = index(rides), byAssist = index(assistance), byRider = index(riders);
  const subjects = pageFlags.map(flag => {
    const subject = flag.subjectType === 'ride' ? byRide.get(String(flag.subject))
      : flag.subjectType === 'assistance' ? byAssist.get(String(flag.context))
        : byRider.get(String(flag.subject));
    return { id: String(flag._id), type: flag.subjectType, reason: flag.reason,
      createdAt: flag.createdAt, subjectId: String(flag.subject), subject: subject ? {
        title: subject.title, origin: subject.origin, destination: subject.destination,
        type: subject.type, description: subject.description, name: subject.name, state: subject.state,
      } : null };
  });
  return Api.success(res, { items: subjects, nextPage: flags.length > limit ? page + 1 : null });
});

moderation.patch('/flags/:id', async (req, res) => {
  const action = req.body?.action;
  if (!['dismiss', 'remove', 'restrict'].includes(action)) return Api.badRequest(res, 'Invalid moderation action.');
  const pending = await CommunityFlag.findOne({ _id: req.params.id, state: 'pending' }).select('subjectType').lean();
  if (!pending) return Api.error(res, 'Report already resolved or unavailable.', 404);
  if ((action === 'restrict' && pending.subjectType !== 'rider') ||
      (action === 'remove' && pending.subjectType === 'rider')) return Api.badRequest(res, 'That moderation action does not apply to this report.');
  const flag = await CommunityFlag.findOneAndUpdate({ _id: req.params.id, state: 'pending' },
    { $set: { state: action === 'dismiss' ? 'dismissed' : 'actioned' } }, { new: true });
  if (!flag) return Api.error(res, 'Report already resolved or unavailable.', 404);
  if (action === 'remove' && flag.subjectType === 'ride') {
    await CommunityRide.updateOne({ _id: flag.subject, state: 'planned' }, { $set: { state: 'cancelled' } });
  } else if (action === 'remove' && flag.subjectType === 'assistance') {
    await AssistanceRequest.updateOne({ _id: flag.context, state: { $in: ['open', 'assigned'] } },
      { $set: { state: 'cancelled' }, $unset: { location: '', activeForUser: '' } });
  } else if (action === 'restrict' && flag.subjectType === 'rider') {
    await User.findOneAndUpdate({ _id: flag.subject, role: 'USER', status: 'active' },
      { $set: { status: 'suspended', status_reason: 'Community safety review' } });
  } else if (action !== 'dismiss') {
    return Api.badRequest(res, 'That moderation action does not apply to this report.');
  }
  audit.log({ req, category: 'ADMIN', action: 'COMMUNITY_FLAG_RESOLVED', resource_type: 'CommunityFlag',
    resource_id: req.params.id, metadata: { action, subjectType: flag.subjectType } });
  return Api.success(res);
});

module.exports = { router, moderation };

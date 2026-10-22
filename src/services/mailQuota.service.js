const EmailLimit = require('../models/EmailLimit.model');

const KEY = 'hostinger-outgoing-rolling-24h';
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Confirmed mailbox: 1,000 outgoing messages/day. Leave 100 for other mailbox use.
const LIMIT = 900;

async function getOutgoingQuota(now = new Date()) {
  const record = await EmailLimit.findById(KEY).lean();
  const cutoff = now.getTime() - WINDOW_MS;
  const recent = (record?.reservations || []).map(value => new Date(value).getTime()).filter(value => value > cutoff);
  const resetAt = recent.length ? new Date(Math.min(...recent) + WINDOW_MS) : null;
  return { limit: LIMIT, providerDailyLimit: 1000, period: '24 hours', used: recent.length, resetAt,
    pausedUntil: recent.length >= LIMIT ? resetAt : null };
}

async function claimOutgoing(now = new Date()) {
  try {
    await EmailLimit.updateOne({ _id: KEY }, { $setOnInsert: { count: 0, reservations: [], resetAt: new Date(now.getTime() + WINDOW_MS) } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const recent = { $filter: { input: { $ifNull: ['$reservations', []] }, as: 'attempt', cond: { $gt: ['$$attempt', new Date(now.getTime() - WINDOW_MS)] } } };
  // Filter and reserve atomically on one shared document, across workers/instances.
  const result = await EmailLimit.findOneAndUpdate({ _id: KEY, $expr: { $lt: [{ $size: recent }, LIMIT] } }, [
    { $set: { reservations: { $concatArrays: [recent, [now]] }, resetAt: new Date(now.getTime() + WINDOW_MS) } },
    { $set: { count: { $size: '$reservations' } } },
  ], { returnDocument: 'after', updatePipeline: true });
  return Boolean(result);
}

module.exports = { claimOutgoing, getOutgoingQuota, KEY, WINDOW_MS, LIMIT };

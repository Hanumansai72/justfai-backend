const CommunityBlock = require('../models/CommunityBlock');

async function blockedRiderIds(userId) {
  const rows = await CommunityBlock.find({ $or: [{ blocker: userId }, { blocked: userId }] })
    .select('blocker blocked').lean();
  const id = String(userId);
  return [...new Set(rows.map(row => String(row.blocker) === id ? String(row.blocked) : String(row.blocker)))];
}

async function isBlockedPair(first, second) {
  return Boolean(await CommunityBlock.exists({ $or: [
    { blocker: first, blocked: second }, { blocker: second, blocked: first },
  ] }));
}

module.exports = { blockedRiderIds, isBlockedPair };

const AppRelease = require('../models/AppRelease.model');

module.exports = async function ensureReleaseIndexes() {
  // Install the replacement constraint before removing the old, stricter one.
  await AppRelease.collection.createIndex({ platform: 1, version: 1 }, { unique: true });
  const indexes = await AppRelease.collection.indexes();
  const legacy = indexes.find(index => index.unique && index.key.version === 1 && Object.keys(index.key).length === 1);
  if (legacy) await AppRelease.collection.dropIndex(legacy.name);
};

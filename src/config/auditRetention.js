const AuditLog = require('../models/AuditLog.model');

module.exports = async function ensureAuditRetention() {
  try {
    await AuditLog.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 });
  } catch (error) {
    // Upgrade an existing createdAt index without dropping any other indexes.
    if (![85, 86].includes(error.code)) throw error;
    await AuditLog.db.db.command({ collMod: AuditLog.collection.name,
      index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: 604800 } });
  }
};

const Admin = require('../models/Admin.model');

// Verify only. Never provision, reset credentials, or choose/delete duplicates.
module.exports = async function verifyAdmin() {
  const count = await Admin.countDocuments({ role: 'ADMIN' });
  if (count !== 1) {
    throw new Error(`Exactly one existing admin is required; found ${count}. No accounts were changed.`);
  }
  await Admin.collection.createIndex(
    { role: 1 },
    { unique: true, partialFilterExpression: { role: 'ADMIN' }, name: 'single_admin' },
  );
};

const cache = require('../../services/cache.service');

// Model hooks cover admin, customer, device, and background-worker writes alike.
module.exports = (schema, { groups }) => {
  const invalidate = async function (result) {
    // Queue polling and updates matching no documents must not flush hot caches.
    if (result === null && this.getOptions && !this.getOptions().upsert) return;
    const counts = ['modifiedCount', 'upsertedCount', 'insertedCount', 'deletedCount'];
    if (counts.some(key => typeof result?.[key] === 'number') &&
        !counts.some(key => (result[key] || 0) > 0)) return;
    if (Array.isArray(result) && result.length === 0) return;
    await cache.invalidate(groups);
  };
  schema.post(['save', 'insertMany', 'bulkWrite', 'updateOne', 'updateMany',
    'replaceOne', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'deleteMany'], invalidate);
  // Document.deleteOne() also executes query middleware in our Mongoose version.
  schema.post('deleteOne', { document: false, query: true }, invalidate);
  // Unordered batches can partially commit before reporting an error.
  schema.post(['insertMany', 'bulkWrite', 'updateMany'], { errorHandler: true }, async function (error) {
    await cache.invalidate(groups);
    throw error;
  });
};

const { waitUntil } = require('@vercel/functions');
const cache = require('../services/cache.service');

// Install after protect/authorize: cached responses never bypass permissions.
module.exports = (group) => async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  const query = Object.keys(req.query).sort().map(key => [key, req.query[key]]);
  const key = JSON.stringify([
    req.path, String(req.user._id), req.user.role, query,
  ]);
  const snapshot = await cache.read(group, key);
  const status = snapshot ? (snapshot.value === null ? 'MISS' : 'HIT') : 'BYPASS';
  res.set('X-Cache', status);
  if (snapshot?.value !== null && snapshot?.value !== undefined) return res.json(snapshot.value);

  const json = res.json;
  res.json = function (body) {
    res.json = json;
    if (snapshot && res.statusCode === 200 && body?.success === true) {
      // Keep cache population off the response path, including on Vercel.
      waitUntil(cache.write(snapshot, body));
    }
    return json.call(this, body);
  };
  return next();
};

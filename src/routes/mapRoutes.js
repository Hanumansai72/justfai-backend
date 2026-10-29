const router = require('express').Router();
const { protect, authorize } = require('../middlewares/authMiddleware');
const { userReadLimiter } = require('../security/rateLimiter');
const { mapParameters, reserveMapRequest, downloadMap } = require('../services/staticMap');

router.get('/static', protect, authorize('USER'), userReadLimiter, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  let parameters;
  try { parameters = mapParameters(req.query); }
  catch { return res.status(400).json({ message: 'Invalid map parameters' }); }
  const key = process.env.LOCATIONIQ_API_KEY;
  if (!key) return res.status(503).json({ message: 'Map provider is not configured' });
  try {
    const retryAfter = await reserveMapRequest();
    if (retryAfter) return res.set('Retry-After', String(retryAfter)).status(429).json({ message: 'Map request budget reached' });
    const map = await downloadMap(parameters, key);
    if (map.status !== 200) return res.set('Retry-After', String(map.retryAfter || 60))
      .status(map.status).json({ message: 'Map provider unavailable' });
    res.set('Server-Timing', `locationiq;dur=${map.elapsedMs}`);
    return res.type('image/jpeg').send(map.bytes);
  } catch {
    // Errors can contain the upstream URL and token. Never log the exception.
    return res.set('Retry-After', '60').status(503).json({ message: 'Map service unavailable' });
  }
});
require('../security/sanitize').sanitizeParams(router);
module.exports = router;

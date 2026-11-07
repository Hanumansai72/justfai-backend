const router = require('express').Router();
const { protect, authorize } = require('../middlewares/authMiddleware');
const { userReadLimiter } = require('../security/rateLimiter');
const { mapParameters, reserveMapRequest, downloadGoogleMap } = require('../services/staticMap');

router.get('/google-static', protect, authorize('USER'), userReadLimiter, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  let parameters;
  try { parameters = mapParameters({ ...req.query, width: req.query.width ?? 226, height: req.query.height ?? 177 }); }
  catch { return res.status(400).json({ message: 'Invalid map parameters' }); }
  const key = process.env.GOOGLE_MAPS_STATIC_API_KEY?.trim();
  if (!key) return res.set('Retry-After', '60').status(503).json({ message: 'Google Static Maps is not configured' });
  let phase = 'budget';
  try {
    const retryAfter = await reserveMapRequest();
    if (retryAfter) return res.set('Retry-After', String(retryAfter)).status(429).json({ message: 'Map request budget reached' });
    phase = 'provider';
    const map = await downloadGoogleMap(parameters, key);
    if (map.status !== 200) return res.set('Retry-After', String(map.retryAfter || 60)).status(map.status).json({ message: 'Google map provider unavailable' });
    return res.type('image/jpeg').send(map.bytes);
  } catch (error) {
    const timeout = ['AbortError', 'TimeoutError'].includes(error?.name);
    const code = phase === 'budget' ? 'MAP_LIMITER_UNAVAILABLE' : timeout ? 'MAP_TIMEOUT' : 'MAP_PROVIDER_UNAVAILABLE';
    return res.set('Retry-After', '60').status(phase === 'budget' ? 503 : timeout ? 504 : 502).json({ code, message: 'Map service unavailable' });
  }
});
require('../security/sanitize').sanitizeParams(router);
module.exports = router;

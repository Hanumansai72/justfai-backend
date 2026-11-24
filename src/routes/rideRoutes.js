const router = require('express').Router();
const { protect, authorize } = require('../middlewares/authMiddleware');
const { userReadLimiter, userWriteLimiter } = require('../security/rateLimiter');
const { saveRide, getRides, getRideSummary } = require('../controllers/ride.controller');

router.use(protect, authorize('USER'), (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
router.get('/', userReadLimiter, getRides);
router.post('/summary', userReadLimiter, getRideSummary);
router.post('/', userWriteLimiter, saveRide);
require('../security/sanitize').sanitizeParams(router);
module.exports = router;

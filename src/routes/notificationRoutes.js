const express = require("express");
const { userLimiter } = require("../security/rateLimiter");
const router  = express.Router();

const { protect } = require("../middlewares/authMiddleware");
const {
  getNotifications,
  markAsRead,
  deleteNotification,
} = require("../controllers/notification.controller");

// All notification routes require authentication
router.use(protect, userLimiter);
const push = require('../controllers/pushNotification.controller');
router.put('/push-registration', push.register);
router.delete('/push-registration', push.unregister);

router.get("/",            getNotifications);
router.patch("/read-all", (req, res, next) => { req.params.id = "read-all"; return markAsRead(req, res, next); });
router.patch("/:id/read",  markAsRead);
router.delete("/:id",      deleteNotification);

require('../security/sanitize').sanitizeParams(router);
module.exports = router;

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

router.get("/",            getNotifications);
router.patch("/:id/read",  markAsRead);
router.delete("/:id",      deleteNotification);

module.exports = router;

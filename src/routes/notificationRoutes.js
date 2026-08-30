const express = require("express");
const router  = express.Router();

const { protect } = require("../middlewares/authMiddleware");
const {
  getNotifications,
  markAsRead,
  deleteNotification,
} = require("../controllers/notification.controller");

// All notification routes require authentication
router.use(protect);

router.get("/",            getNotifications);
router.patch("/:id/read",  markAsRead);
router.delete("/:id",      deleteNotification);

module.exports = router;

/**
 * routes/chatRoutes.js
 * Express routing for real-time chat REST fallbacks and message history.
 */
const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const {
  getTicketMessages,
  sendMessage,
  markAsRead,
  getUnreadCount,
  getUserPresence,
} = require("../controllers/chat.controller");

// All chat routes require JWT authentication
router.use(protect);

router.get("/tickets/:ticketId/messages", getTicketMessages);
router.post("/tickets/:ticketId/messages", sendMessage);
router.post("/tickets/:ticketId/read", markAsRead);
router.get("/tickets/:ticketId/unread", getUnreadCount);
router.get("/presence/:userId", getUserPresence);

module.exports = router;

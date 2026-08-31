/**
 * controllers/chat.controller.js
 * REST API Controller for Chat History, Message Dispatch (Fallback/REST), and Presence.
 */
const chatService = require("../services/chat.service");
const presenceService = require("../services/presence.service");
const { getIO } = require("../socket");

// ─────────────────────────────────────────────
// @desc    Get paginated message history for a ticket
// @route   GET /api/chat/tickets/:ticketId/messages
// @access  Private
// ─────────────────────────────────────────────
exports.getTicketMessages = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { limit = 50, skip = 0 } = req.query;

    // Verify access
    await chatService.verifyTicketAccess(ticketId, req.user);

    const result = await chatService.getTicketMessages({
      ticketId,
      limit: parseInt(limit, 10),
      skip: parseInt(skip, 10),
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Send message via REST (HTTP fallback & upload compatibility)
// @route   POST /api/chat/tickets/:ticketId/messages
// @access  Private
// ─────────────────────────────────────────────
exports.sendMessage = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { body, attachments, clientMsgId } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({ success: false, message: "Message body is required" });
    }

    // Verify access
    await chatService.verifyTicketAccess(ticketId, req.user);

    // Save message in database & trigger notifications
    const result = await chatService.saveMessage({
      ticketId,
      sender: req.user,
      body,
      attachments,
      clientMsgId,
    });

    // Broadcast in real-time via Socket.IO if active
    try {
      const io = getIO();
      io.to(`ticket:${ticketId}`).emit("receive_message", result);
    } catch (e) {
      // Socket not initialized or offline - REST response still succeeds
    }

    res.status(201).json({
      success: true,
      message: "Message sent",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Mark ticket messages as read
// @route   POST /api/chat/tickets/:ticketId/read
// @access  Private
// ─────────────────────────────────────────────
exports.markAsRead = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const userId = (req.user._id || req.user.id).toString();

    await chatService.verifyTicketAccess(ticketId, req.user);
    const result = await chatService.markAsRead(ticketId, userId);

    try {
      const io = getIO();
      io.to(`ticket:${ticketId}`).emit("messages_read", {
        ticketId,
        readBy: userId,
        readAt: new Date(),
      });
    } catch (e) {}

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get unread message count for a ticket
// @route   GET /api/chat/tickets/:ticketId/unread
// @access  Private
// ─────────────────────────────────────────────
exports.getUnreadCount = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const userId = (req.user._id || req.user.id).toString();

    await chatService.verifyTicketAccess(ticketId, req.user);
    const count = await presenceService.getUnreadCount(ticketId, userId);

    res.status(200).json({
      success: true,
      data: { ticket_id: ticketId, unread_count: count },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get presence status of a user
// @route   GET /api/chat/presence/:userId
// @access  Private
// ─────────────────────────────────────────────
exports.getUserPresence = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const status = await presenceService.getUserStatus(userId);

    res.status(200).json({
      success: true,
      data: { user_id: userId, ...status },
    });
  } catch (error) {
    next(error);
  }
};

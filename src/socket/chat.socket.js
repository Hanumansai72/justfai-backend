/**
 * socket/chat.socket.js
 * Scalable event handlers for Socket.IO real-time chat.
 *
 * Implements:
 *   - Socket rate limiting (prevents flooding / abuse)
 *   - Room subscriptions: `ticket:<ticketId>` & `user:<userId>`
 *   - Reliable message broadcasting with sender ACK callback
 *   - Ephemeral typing indicators
 *   - Read receipts & presence management
 */
const chatService = require("../services/chat.service");
const presenceService = require("../services/presence.service");

// Simple sliding window rate limiter per socket (max 10 messages per 5 seconds)
const socketMessageCounts = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 5000;

const isRateLimited = (socketId) => {
  const now = Date.now();
  const entry = socketMessageCounts.get(socketId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    socketMessageCounts.set(socketId, entry);
    return false;
  }

  entry.count += 1;
  socketMessageCounts.set(socketId, entry);
  return entry.count > RATE_LIMIT_MAX;
};

module.exports = (io, socket) => {
  const user = socket.user;
  const userId = (user._id || user.id).toString();

  // Automatically join private user room for targeted notifications/events
  socket.join(`user:${userId}`);

  // Register online presence
  presenceService.setUserOnline(userId, socket.id).catch(() => {});

  // Broadcast presence to relevant listeners
  io.emit("presence_update", { userId, isOnline: true });

  // ─────────────────────────────────────────────
  // Event: join_ticket
  // Subscribes socket to ticket room: `ticket:<ticketId>`
  // ─────────────────────────────────────────────
  socket.on("join_ticket", async (data, callback) => {
    try {
      const ticketId = typeof data === "string" ? data : data?.ticketId;
      if (!ticketId) {
        if (typeof callback === "function") callback({ success: false, message: "ticketId is required" });
        return;
      }

      // Verify access permission
      await chatService.verifyTicketAccess(ticketId, user);

      const roomName = `ticket:${ticketId}`;
      socket.join(roomName);

      // Clear unread count for this user
      await presenceService.clearUnread(ticketId, userId);

      // Notify others in room that user has joined/viewing
      socket.to(roomName).emit("user_joined_ticket", {
        ticketId,
        user: { id: userId, name: user.name, role: user.role },
      });

      if (typeof callback === "function") {
        callback({ success: true, message: `Joined room ${roomName}` });
      }
    } catch (err) {
      if (typeof callback === "function") {
        callback({ success: false, message: err.message || "Failed to join ticket room" });
      }
    }
  });

  // ─────────────────────────────────────────────
  // Event: leave_ticket
  // Leaves ticket room
  // ─────────────────────────────────────────────
  socket.on("leave_ticket", (data, callback) => {
    try {
      const ticketId = typeof data === "string" ? data : data?.ticketId;
      if (ticketId) {
        const roomName = `ticket:${ticketId}`;
        socket.leave(roomName);
        socket.to(roomName).emit("user_left_ticket", {
          ticketId,
          userId,
        });
      }
      if (typeof callback === "function") callback({ success: true });
    } catch (err) {
      if (typeof callback === "function") callback({ success: false, message: err.message });
    }
  });

  // ─────────────────────────────────────────────
  // Event: send_message
  // Persists message to MongoDB and broadcasts to room
  // ─────────────────────────────────────────────
  socket.on("send_message", async (data, callback) => {
    try {
      if (isRateLimited(socket.id)) {
        if (typeof callback === "function") {
          return callback({ success: false, message: "Rate limit exceeded. Please slow down." });
        }
        return;
      }

      const { ticketId, body, attachments, clientMsgId } = data || {};

      if (!ticketId || !body) {
        if (typeof callback === "function") {
          return callback({ success: false, message: "ticketId and body are required" });
        }
        return;
      }

      // Verify access
      await chatService.verifyTicketAccess(ticketId, user);

      // Save to database & get populated message payload
      const result = await chatService.saveMessage({
        ticketId,
        sender: user,
        body,
        attachments,
        clientMsgId,
      });

      const roomName = `ticket:${ticketId}`;

      // Broadcast to everyone in the ticket room (including sender if on multiple devices)
      io.to(roomName).emit("receive_message", result);

      // Send ACK back to the emitting client
      if (typeof callback === "function") {
        callback({
          success: true,
          clientMsgId,
          message: result.message,
        });
      }
    } catch (err) {
      if (typeof callback === "function") {
        callback({
          success: false,
          clientMsgId: data?.clientMsgId,
          message: err.message || "Failed to send message",
        });
      }
    }
  });

  // ─────────────────────────────────────────────
  // Event: typing_start & typing_stop
  // Ephemeral indicator broadcasted via Redis/Socket
  // ─────────────────────────────────────────────
  socket.on("typing_start", (data) => {
    const ticketId = data?.ticketId;
    if (ticketId) {
      socket.to(`ticket:${ticketId}`).emit("user_typing", {
        ticketId,
        user: { id: userId, name: user.name },
        isTyping: true,
      });
    }
  });

  socket.on("typing_stop", (data) => {
    const ticketId = data?.ticketId;
    if (ticketId) {
      socket.to(`ticket:${ticketId}`).emit("user_typing", {
        ticketId,
        user: { id: userId, name: user.name },
        isTyping: false,
      });
    }
  });

  // ─────────────────────────────────────────────
  // Event: mark_as_read
  // ─────────────────────────────────────────────
  socket.on("mark_as_read", async (data, callback) => {
    try {
      const ticketId = data?.ticketId;
      if (!ticketId) return;

      await chatService.markAsRead(ticketId, userId);

      socket.to(`ticket:${ticketId}`).emit("messages_read", {
        ticketId,
        readBy: userId,
        readAt: new Date(),
      });

      if (typeof callback === "function") callback({ success: true });
    } catch (err) {
      if (typeof callback === "function") callback({ success: false, message: err.message });
    }
  });

  // ─────────────────────────────────────────────
  // Event: disconnect
  // Cleans up presence and memory rate limiters
  // ─────────────────────────────────────────────
  socket.on("disconnect", async () => {
    socketMessageCounts.delete(socket.id);

    const isFullyOffline = await presenceService.setUserOffline(userId, socket.id);
    if (isFullyOffline) {
      io.emit("presence_update", { userId, isOnline: false, lastSeen: Date.now() });
    }
  });
};

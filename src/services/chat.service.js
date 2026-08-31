/**
 * services/chat.service.js
 * Scalable chat business logic:
 *   - Atomic MongoDB message append
 *   - Secure room and ticket authorization verification
 *   - Cursor-based message pagination ($slice / MongoDB aggregation)
 *   - Read status synchronization
 */
const mongoose = require("mongoose");
const SupportTicket = require("../models/SupportTicket.model");
const presenceService = require("./presence.service");
const { notifyTicketReply } = require("../queues/notification.queue");

class ChatService {
  /**
   * Verify whether a user is authorized to participate in a ticket chat.
   * Users can only access their own tickets; Admins & Helpers can access all tickets.
   * @param {string} ticketId
   * @param {Object} user
   * @returns {Promise<Object>} SupportTicket document
   */
  async verifyTicketAccess(ticketId, user) {
    if (!mongoose.Types.ObjectId.isValid(ticketId)) {
      const err = new Error("Invalid ticket ID format");
      err.statusCode = 400;
      throw err;
    }

    const isStaff = user.role === "ADMIN" || user.role === "HELPER";
    const query = { _id: ticketId };
    if (!isStaff) {
      query.user_id = user._id || user.id;
    }

    const ticket = await SupportTicket.findOne(query).select("_id user_id status subject ticket_number assigned_to");
    if (!ticket) {
      const err = new Error("Ticket not found or unauthorized");
      err.statusCode = 403;
      throw err;
    }

    return ticket;
  }

  /**
   * Append message atomically and return the populated message object.
   * @param {Object} params
   * @param {string} params.ticketId
   * @param {Object} params.sender - { id, name, avatar, role }
   * @param {string} params.body
   * @param {Array<string>} [params.attachments]
   * @param {string} [params.clientMsgId]
   */
  async saveMessage({ ticketId, sender, body, attachments = [], clientMsgId = null }) {
    if (!body || !body.trim()) {
      const err = new Error("Message body cannot be empty");
      err.statusCode = 400;
      throw err;
    }

    const senderId = sender._id || sender.id;
    const senderRole = sender.role === "ADMIN" || sender.role === "HELPER" ? "ADMIN" : "USER";

    const newMessage = {
      sender_id: senderId,
      sender_role: senderRole,
      body: body.trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Atomic push to messages array and update status
    const updatedTicket = await SupportTicket.findByIdAndUpdate(
      ticketId,
      {
        $push: { messages: newMessage },
        $set: {
          status: senderRole === "USER" ? "open" : "in_progress",
          updatedAt: new Date(),
        },
      },
      { new: true, select: { messages: { $slice: -1 }, user_id: 1, ticket_number: 1, subject: 1 } }
    ).populate("messages.sender_id", "name avatar role");

    if (!updatedTicket || !updatedTicket.messages.length) {
      const err = new Error("Failed to save message to ticket");
      err.statusCode = 500;
      throw err;
    }

    const savedMsg = updatedTicket.messages[0].toObject();

    // Determine recipient to update unread count & background notification
    const recipientUserId = senderRole === "USER"
      ? (updatedTicket.assigned_to ? updatedTicket.assigned_to.toString() : null)
      : updatedTicket.user_id.toString();

    if (recipientUserId) {
      await presenceService.incrementUnread(ticketId, recipientUserId);
    }

    // Trigger asynchronous notification queue if sender is customer or staff
    try {
      if (senderRole === "USER") {
        notifyTicketReply({
          ticket: updatedTicket,
          customer: sender,
          messageText: body,
        }).catch(() => {});
      }
    } catch (e) {
      // Non-blocking notification fail
    }

    return {
      ticket_id: ticketId,
      client_msg_id: clientMsgId,
      message: {
        _id: savedMsg._id,
        body: savedMsg.body,
        attachments: savedMsg.attachments,
        sender_role: savedMsg.sender_role,
        sender: {
          _id: senderId,
          name: sender.name || "User",
          avatar: sender.avatar || null,
          role: senderRole,
        },
        createdAt: savedMsg.createdAt,
      },
    };
  }

  /**
   * Get paginated messages for a ticket (Cursor-based or slice pagination).
   * @param {Object} params
   * @param {string} params.ticketId
   * @param {number} [params.limit=30]
   * @param {number} [params.skip=0]
   */
  async getTicketMessages({ ticketId, limit = 50, skip = 0 }) {
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const parsedSkip = Math.max(parseInt(skip, 10) || 0, 0);

    const ticket = await SupportTicket.findById(ticketId, {
      messages: { $slice: [-(parsedSkip + parsedLimit), parsedLimit] },
      ticket_number: 1,
      subject: 1,
      status: 1,
      user_id: 1,
    }).populate("messages.sender_id", "name avatar role email");

    if (!ticket) {
      const err = new Error("Ticket not found");
      err.statusCode = 404;
      throw err;
    }

    const messages = (ticket.messages || []).map((msg) => {
      const senderObj = msg.sender_id && typeof msg.sender_id === "object" ? msg.sender_id : {};
      return {
        _id: msg._id,
        body: msg.body,
        attachments: msg.attachments || [],
        sender_role: msg.sender_role,
        sender: {
          _id: senderObj._id || msg.sender_id,
          name: senderObj.name || "Unknown",
          avatar: senderObj.avatar || null,
          role: senderObj.role || msg.sender_role,
        },
        createdAt: msg.createdAt,
      };
    });

    return {
      ticket_id: ticket._id,
      ticket_number: ticket.ticket_number,
      subject: ticket.subject,
      status: ticket.status,
      count: messages.length,
      messages,
    };
  }

  /**
   * Mark all messages in a ticket as read for a user.
   * @param {string} ticketId
   * @param {string} userId
   */
  async markAsRead(ticketId, userId) {
    await presenceService.clearUnread(ticketId, userId);
    return { success: true, ticket_id: ticketId, read_at: new Date() };
  }
}

module.exports = new ChatService();

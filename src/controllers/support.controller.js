/**
 * controllers/support.controller.js
 * User-facing customer support, issue reporting, and feedback endpoints:
 *   - Report device problem
 *   - Report connection issue
 *   - Contact support
 *   - Submit feedback
 *   - Get ticket history & chat messages
 */
const SupportTicket = require("../models/SupportTicket.model");
const Device        = require("../models/device.model");
const audit         = require("../security/auditLogger");
const { sendNotification } = require("./notification.controller");
const { notifyNewTicket, notifyTicketReply } = require("../queues/notification.queue");

// ─────────────────────────────────────────────
// @desc    Report a hardware / device problem
// @route   POST /api/support/device-problem
// @access  Private
// ─────────────────────────────────────────────
exports.reportDeviceProblem = async (req, res, next) => {
  try {
    const { device_id, subject, description, priority = "high", attachments } = req.body;

    if (!subject || !description) {
      return res.status(400).json({ success: false, message: "Subject and description are required" });
    }

    // Optional device validation
    let validDeviceId = null;
    let deviceDoc = null;
    if (device_id) {
      deviceDoc = await Device.findOne({
        $or: [{ _id: device_id.match(/^[0-9a-fA-F]{24}$/) ? device_id : null }, { device_id }],
        linked_to: req.user._id,
      }).select("_id devicename device_id BLE_ADDRESS");
      if (deviceDoc) validDeviceId = deviceDoc._id;
    }

    const ticket = await SupportTicket.create({
      user_id:     req.user._id,
      device_id:   validDeviceId,
      category:    "device_problem",
      subject,
      description,
      priority,
      messages: [
        {
          sender_id:   req.user._id,
          sender_role: "USER",
          body:        description,
          attachments: attachments || [],
        },
      ],
    });

    audit.log({
      req, category: "SYSTEM", action: "REPORT_DEVICE_PROBLEM", status: "SUCCESS",
      resource_type: "System", resource_id: ticket._id,
      message: `Device problem reported: ${subject} (${ticket.ticket_number})`,
    });

    // Notify user
    await sendNotification({
      user_id: req.user._id,
      type: "ACCOUNT_NOTIFICATION",
      title: "Support Ticket Created",
      message: `Your device problem report (${ticket.ticket_number}) has been received. Our team is investigating.`,
      data: { ticket_id: ticket._id, ticket_number: ticket.ticket_number },
    });

    // Dispatch real-time notification to Admins & Customer Care Helpers via BullMQ queue
    await notifyNewTicket({ ticket, customer: req.user, device: deviceDoc });

    res.status(201).json({
      success: true,
      message: "Device problem reported successfully",
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Report a BLE / Cloud connection issue
// @route   POST /api/support/connection-issue
// @access  Private
// ─────────────────────────────────────────────
exports.reportConnectionIssue = async (req, res, next) => {
  try {
    const { device_id, BLE_ADDRESS, description, error_code, app_version } = req.body;

    if (!description) {
      return res.status(400).json({ success: false, message: "Description of the connection issue is required" });
    }

    const subject = `Connection Issue: ${BLE_ADDRESS || device_id || "Bluetooth Link Failed"}`;

    const ticket = await SupportTicket.create({
      user_id:     req.user._id,
      category:    "connection_issue",
      subject,
      description: `[Error: ${error_code || "N/A"} | App: ${app_version || "N/A"}]\n${description}`,
      priority:    "high",
      messages: [
        {
          sender_id:   req.user._id,
          sender_role: "USER",
          body:        description,
        },
      ],
    });

    // Dispatch notification to staff queue
    await notifyNewTicket({ ticket, customer: req.user });

    res.status(201).json({
      success: true,
      message: "Connection issue reported. Ticket generated.",
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    General Contact Support
// @route   POST /api/support/contact
// @access  Private
// ─────────────────────────────────────────────
exports.contactSupport = async (req, res, next) => {
  try {
    const { subject, message, priority = "medium" } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ success: false, message: "Subject and message are required" });
    }

    const ticket = await SupportTicket.create({
      user_id:     req.user._id,
      category:    "contact_support",
      subject,
      description: message,
      priority,
      messages: [
        {
          sender_id:   req.user._id,
          sender_role: "USER",
          body:        message,
        },
      ],
    });

    // Dispatch notification to staff queue
    await notifyNewTicket({ ticket, customer: req.user });

    res.status(201).json({
      success: true,
      message: "Your message has been sent to customer support.",
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Submit Feedback / Feature Request
// @route   POST /api/support/feedback
// @access  Private
// ─────────────────────────────────────────────
exports.submitFeedback = async (req, res, next) => {
  try {
    const { title, feedback, rating } = req.body;

    if (!feedback) {
      return res.status(400).json({ success: false, message: "Feedback content is required" });
    }

    const ticket = await SupportTicket.create({
      user_id:     req.user._id,
      category:    "feedback",
      subject:     title || `User Feedback (Rating: ${rating || "N/A"}/5)`,
      description: feedback,
      priority:    "low",
      messages: [
        {
          sender_id:   req.user._id,
          sender_role: "USER",
          body:        feedback,
        },
      ],
    });

    // Dispatch notification to staff queue
    await notifyNewTicket({ ticket, customer: req.user });

    res.status(201).json({
      success: true,
      message: "Thank you for your feedback! It helps us improve JustRide.",
      data: { ticket_id: ticket._id, ticket_number: ticket.ticket_number },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get user's support tickets
// @route   GET /api/support/my-tickets
// @access  Private
// ─────────────────────────────────────────────
exports.getMyTickets = async (req, res, next) => {
  try {
    const tickets = await SupportTicket.find({ user_id: req.user._id })
      .select("-messages")
      .populate("device_id", "devicename device_id BLE_ADDRESS")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: tickets.length,
      data: tickets,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get details + message thread of a user's ticket
// @route   GET /api/support/tickets/:id
// @access  Private
// ─────────────────────────────────────────────
exports.getTicketDetails = async (req, res, next) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      user_id: req.user._id,
    })
      .populate("messages.sender_id", "name avatar role")
      .populate("device_id", "devicename device_id")
      .lean();

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }

    res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    User reply to a support ticket
// @route   POST /api/support/tickets/:id/messages
// @access  Private
// ─────────────────────────────────────────────
exports.addTicketMessage = async (req, res, next) => {
  try {
    const { message, attachments } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, message: "Message is required" });
    }

    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user._id },
      {
        $push: {
          messages: {
            sender_id:   req.user._id,
            sender_role: "USER",
            body:        message,
            attachments: attachments || [],
            createdAt:   new Date(),
            updatedAt:   new Date(),
          },
        },
        $set: { status: "open" }, // Reopen ticket on user reply
      },
      { new: true }
    )
      .populate("messages.sender_id", "name avatar role")
      .lean();

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }

    // Notify assigned helper or support staff that customer replied
    await notifyTicketReply({
      ticket,
      customer: req.user,
      messageText: message,
    });

    res.status(200).json({
      success: true,
      message: "Message sent",
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};

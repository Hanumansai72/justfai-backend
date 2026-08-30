/**
 * admin/support.controller.js
 *
 * Optimisation notes:
 *   - getSupportTickets: lean() + parallel count+data, compound index hits
 *   - getSupportTicket: single query with full populate chain — no post-fetch joins
 *   - updateSupportTicket: atomic findByIdAndUpdate with conditional $push for new messages;
 *     uses MongoDB $push to append a message in one operation instead of fetch+push+save
 */
const SupportTicket = require("../../models/SupportTicket.model");
const audit         = require("../../security/auditLogger");

// ─────────────────────────────────────────────
// @desc    List support tickets with filters + pagination
// @route   GET /api/admin/support?status=open&priority=high&assigned_to=me&page=1
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getSupportTickets = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.status && ["open", "in_progress", "resolved", "closed"].includes(req.query.status))
      filter.status = req.query.status;
    if (req.query.priority && ["low", "medium", "high", "critical"].includes(req.query.priority))
      filter.priority = req.query.priority;
    // "me" shorthand — show only tickets assigned to the requesting admin
    if (req.query.assigned_to) {
      filter.assigned_to = req.query.assigned_to === "me" ? req.user._id : req.query.assigned_to;
    }
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ subject: rx }, { ticket_number: rx }];
    }

    // Parallel count + data — hits compound index { status, priority, createdAt }
    const [total, tickets] = await Promise.all([
      SupportTicket.countDocuments(filter),
      SupportTicket.find(filter)
        .select("-messages")             // Exclude embedded messages from list view — big payloads
        .populate("user_id",     "name email phonenumber")
        .populate("device_id",   "devicename device_id BLE_ADDRESS")
        .populate("assigned_to", "name email")
        .sort({ priority: -1, createdAt: -1 })  // Critical first, newest first
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: tickets.length,
      data: tickets,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get a single support ticket with full message thread
// @route   GET /api/admin/support/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getSupportTicket = async (req, res, next) => {
  try {
    /**
     * Single query with full populate chain — no post-fetch joins.
     * messages.sender_id is populated inline using the dot-path syntax.
     */
    const ticket = await SupportTicket.findById(req.params.id)
      .populate("user_id",              "name email phonenumber avatar")
      .populate("device_id",            "devicename device_id BLE_ADDRESS firmware_version")
      .populate("assigned_to",          "name email")
      .populate("messages.sender_id",   "name email role")
      .lean();

    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

    res.status(200).json({ success: true, data: ticket });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update ticket status, assignment, priority, or add an admin reply
// @route   PATCH /api/admin/support/:id
// @access  Private/Admin
// Body: { status?, priority?, assigned_to?, message? }
// ─────────────────────────────────────────────
exports.updateSupportTicket = async (req, res, next) => {
  try {
    const { status, priority, assigned_to, message } = req.body;

    const setOps   = {};
    const pushOps  = {};
    const validStatuses  = ["open", "in_progress", "resolved", "closed"];
    const validPriorities = ["low", "medium", "high", "critical"];

    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(", ")}` });
      }
      setOps.status = status;
      if (status === "resolved") setOps.resolved_at = new Date();
      if (status === "closed")   setOps.closed_at   = new Date();
    }

    if (priority) {
      if (!validPriorities.includes(priority)) {
        return res.status(400).json({ success: false, message: `priority must be one of: ${validPriorities.join(", ")}` });
      }
      setOps.priority = priority;
    }

    if (assigned_to !== undefined) setOps.assigned_to = assigned_to || null;

    /**
     * OPTIMISATION: if there's a message reply, use MongoDB $push to append it
     * in the SAME atomic update operation — no need to fetch the document first.
     * This is the key optimisation: one write instead of fetch+push+save (3 ops).
     */
    if (message) {
      pushOps.messages = {
        sender_id:   req.user._id,
        sender_role: "ADMIN",
        body:        message,
        createdAt:   new Date(),
        updatedAt:   new Date(),
      };
    }

    if (!Object.keys(setOps).length && !Object.keys(pushOps).length) {
      return res.status(400).json({ success: false, message: "No update fields provided" });
    }

    const updateOp = {};
    if (Object.keys(setOps).length)  updateOp.$set  = setOps;
    if (Object.keys(pushOps).length) updateOp.$push = pushOps;

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      updateOp,
      { new: true, select: "ticket_number status priority assigned_to resolved_at closed_at" }
    )
      .populate("assigned_to", "name email")
      .lean();

    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

    if (status) {
      audit.log({
        req, category: "ADMIN", action: "SUPPORT_TICKET_UPDATE", status: "SUCCESS",
        resource_type: "System", resource_id: req.params.id,
        message: `Ticket ${ticket.ticket_number} → ${status}`,
        metadata: { status, priority, assigned_to },
      });
    }

    res.status(200).json({ success: true, message: "Ticket updated successfully", data: ticket });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Customer Support Action: Block device directly from support ticket
// @route   POST /api/admin/support/:id/block-device
// @access  Private/Admin/Helper
// ─────────────────────────────────────────────
exports.blockDeviceFromTicket = async (req, res, next) => {
  try {
    const { reason = "Blocked by customer support investigation" } = req.body;

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

    const Device = require("../../models/device.model");
    const { sendNotification } = require("../notification.controller");

    const targetDeviceId = ticket.device_id;
    if (!targetDeviceId) {
      return res.status(400).json({
        success: false,
        message: "This ticket does not have a linked device to block",
      });
    }

    const device = await Device.findByIdAndUpdate(
      targetDeviceId,
      {
        $set: {
          is_blocked:   true,
          block_reason: reason,
          blocked_at:   new Date(),
          blocked_by:   req.user._id,
          is_active:    false,
        },
      },
      { new: true, select: "devicename device_id BLE_ADDRESS is_blocked" }
    ).lean();

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    // Append system message to ticket chat thread
    ticket.messages.push({
      sender_id:   req.user._id,
      sender_role: "ADMIN",
      body:        `[SYSTEM ACTION] Device ${device.device_id || device.BLE_ADDRESS} was BLOCKED by support staff (${req.user.name}). Reason: ${reason}`,
    });
    ticket.status = "in_progress";
    await ticket.save();

    // Notify customer
    await sendNotification({
      user_id: ticket.user_id,
      type: "SECURITY_ALERT",
      title: "Device Blocked by Support",
      message: `Your device (${device.devicename || device.device_id}) has been temporarily blocked for security.`,
      data: { device_id: device.device_id, ticket_number: ticket.ticket_number },
    });

    audit.log({
      req, category: "ADMIN", action: "SUPPORT_BLOCK_DEVICE", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Support staff ${req.user.name} blocked device ${device.device_id} via ticket ${ticket.ticket_number}`,
    });

    res.status(200).json({
      success: true,
      message: `Device ${device.device_id} successfully blocked`,
      data: { device, ticket_number: ticket.ticket_number },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Customer Support Action: Force-unlink / unlock device from support ticket
// @route   POST /api/admin/support/:id/force-unlink-device
// @access  Private/Admin/Helper
// ─────────────────────────────────────────────
exports.forceUnlinkDeviceFromTicket = async (req, res, next) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

    const Device = require("../../models/device.model");
    const { sendNotification } = require("../notification.controller");

    const targetDeviceId = ticket.device_id;
    if (!targetDeviceId) {
      return res.status(400).json({
        success: false,
        message: "This ticket does not have a linked device to unlink",
      });
    }

    const device = await Device.findById(targetDeviceId).select("_id devicename device_id BLE_ADDRESS is_paired linked_to");
    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    // Atomic wipe of pairing credentials
    await Device.updateOne(
      { _id: device._id },
      {
        $set:   { is_paired: false, linked_to: null, unlink_date: new Date(), unlink_by: req.user._id },
        $unset: { device_hash: "", pairing_code: "", unlink_otp: "", unlink_otp_expires: "" },
      }
    );

    // Append resolution action to ticket conversation
    ticket.messages.push({
      sender_id:   req.user._id,
      sender_role: "ADMIN",
      body:        `[SYSTEM ACTION] Device ${device.device_id || device.BLE_ADDRESS} was FORCE-UNLINKED / UNLOCKED by support staff (${req.user.name}). Pairing credentials have been reset.`,
    });
    ticket.status = "resolved";
    ticket.resolved_at = new Date();
    await ticket.save();

    // Notify customer
    await sendNotification({
      user_id: ticket.user_id,
      type: "DEVICE_DISCONNECTED",
      title: "Device Unlinked by Support",
      message: `Your device (${device.devicename || device.device_id}) was unlinked by customer support as requested. You may now pair it with any account.`,
      data: { device_id: device.device_id, ticket_number: ticket.ticket_number },
    });

    audit.log({
      req, category: "ADMIN", action: "SUPPORT_FORCE_UNLINK_DEVICE", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Support staff ${req.user.name} force-unlinked device ${device.device_id} via ticket ${ticket.ticket_number}`,
    });

    res.status(200).json({
      success: true,
      message: `Device ${device.device_id} force-unlinked and ticket resolved`,
      data: { device: { _id: device._id, device_id: device.device_id, is_paired: false }, ticket_number: ticket.ticket_number },
    });
  } catch (error) {
    next(error);
  }
};


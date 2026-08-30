/**
 * controllers/admin/notification.controller.js
 * Admin & Customer Care Staff Notification Inbox & Alert Management.
 *
 * Implements:
 *   - Staff Notification Inbox with Broadcast & Direct Routing
 *   - Unread Badge Counters (Top Navbar Bell Indicator)
 *   - Granular Filtering by Notification Type & Priority
 *   - Multi-Staff Broadcast Read-Tracking
 */
const Notification = require("../../models/Notification.model");

// ─────────────────────────────────────────────
// @desc    Get Staff & Admin notifications inbox
// @route   GET /api/admin/notifications?unread_only=true&type=NEW_SUPPORT_TICKET&priority=urgent
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getStaffNotifications = async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === "ADMIN";
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    // Build audience routing query:
    // Matches:
    //  1. Broadcasts to ALL_STAFF
    //  2. Broadcasts to ADMIN_ONLY (if super admin) or HELPER_ONLY (if helper)
    //  3. Direct individual notifications targeted to this staff's ObjectId
    const audienceConditions = [
      { target_audience: "ALL_STAFF" },
      { recipient_id: req.user._id },
    ];

    if (isSuperAdmin) {
      audienceConditions.push({ target_audience: "ADMIN_ONLY" });
    } else {
      audienceConditions.push({ target_audience: "HELPER_ONLY" });
    }

    const query = { $or: audienceConditions };

    if (req.query.type) {
      query.type = req.query.type;
    }

    if (req.query.priority) {
      query.priority = req.query.priority.toLowerCase();
    }

    // Filter unread notifications
    if (req.query.unread_only === "true") {
      query.$and = [
        { is_read: false },
        { "read_by.staff_id": { $ne: req.user._id } },
      ];
    }

    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(query),
    ]);

    // Annotate whether this specific staff member has read the notification
    const formatted = notifications.map((n) => {
      const hasRead =
        n.is_read ||
        (n.read_by && n.read_by.some((r) => r.staff_id?.toString() === req.user._id.toString()));

      return {
        id:              n._id,
        type:            n.type,
        priority:        n.priority || "medium",
        title:           n.title,
        message:         n.message,
        data:            n.data || {},
        target_audience: n.target_audience,
        is_read:         hasRead,
        createdAt:       n.createdAt,
      };
    });

    res.status(200).json({
      success: true,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      data: formatted,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get unread notification count badge
// @route   GET /api/admin/notifications/unread-count
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.getStaffUnreadCount = async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === "ADMIN";

    const audienceConditions = [
      { target_audience: "ALL_STAFF" },
      { recipient_id: req.user._id },
    ];

    if (isSuperAdmin) audienceConditions.push({ target_audience: "ADMIN_ONLY" });
    else audienceConditions.push({ target_audience: "HELPER_ONLY" });

    const count = await Notification.countDocuments({
      $or: audienceConditions,
      is_read: false,
      "read_by.staff_id": { $ne: req.user._id },
    });

    res.status(200).json({
      success: true,
      unread_count: count,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Mark a single staff notification as read
// @route   PATCH /api/admin/notifications/:id/read
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.markStaffNotificationRead = async (req, res, next) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    if (notification.target_audience === "INDIVIDUAL" && notification.recipient_id?.toString() === req.user._id.toString()) {
      notification.is_read = true;
      notification.read_at = new Date();
    }

    // Record this staff member in read_by list if not already present
    const alreadyRead = notification.read_by.some(
      (r) => r.staff_id?.toString() === req.user._id.toString()
    );

    if (!alreadyRead) {
      notification.read_by.push({
        staff_id: req.user._id,
        read_at: new Date(),
      });
    }

    await notification.save();

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Mark all staff notifications as read
// @route   PATCH /api/admin/notifications/mark-all-read
// @access  Private (ADMIN or HELPER)
// ─────────────────────────────────────────────
exports.markAllStaffNotificationsRead = async (req, res, next) => {
  try {
    const isSuperAdmin = req.user.role === "ADMIN";

    const audienceConditions = [
      { target_audience: "ALL_STAFF" },
      { recipient_id: req.user._id },
    ];

    if (isSuperAdmin) audienceConditions.push({ target_audience: "ADMIN_ONLY" });
    else audienceConditions.push({ target_audience: "HELPER_ONLY" });

    // Atomic push of current staff ID into read_by for all unread matching notifications
    await Notification.updateMany(
      {
        $or: audienceConditions,
        "read_by.staff_id": { $ne: req.user._id },
      },
      {
        $push: {
          read_by: {
            staff_id: req.user._id,
            read_at: new Date(),
          },
        },
      }
    );

    // Also mark individual ones as is_read: true
    await Notification.updateMany(
      { recipient_id: req.user._id, is_read: false },
      { $set: { is_read: true, read_at: new Date() } }
    );

    res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    next(error);
  }
};

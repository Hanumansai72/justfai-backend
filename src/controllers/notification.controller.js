/**
 * controllers/notification.controller.js
 * User notification management for:
 *   - FIRMWARE_UPDATE
 *   - DEVICE_DISCONNECTED
 *   - DEVICE_PAIRING
 *   - SECURITY_ALERT
 *   - ACCOUNT_NOTIFICATION
 */
const Notification = require("../models/Notification.model");

// ─────────────────────────────────────────────
// @desc    Get user notifications (Paginated, unread count)
// @route   GET /api/notifications?page=1&limit=20&is_read=false&type=FIRMWARE_UPDATE
// @access  Private
// ─────────────────────────────────────────────
exports.getNotifications = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const filter = { user_id: req.user._id };
    if (req.query.is_read !== undefined) {
      filter.is_read = req.query.is_read === "true";
    }
    if (req.query.type) {
      filter.type = req.query.type.toUpperCase();
    }

    // Parallel count, unread count, and paginated data fetch
    const [total, unreadCount, notifications] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.countDocuments({ user_id: req.user._id, is_read: false }),
      Notification.find(filter)
        .sort({ is_read: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      unread_count: unreadCount,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: notifications.length,
      data: notifications,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Mark notification(s) as read
// @route   PATCH /api/notifications/:id/read OR PATCH /api/notifications/read-all
// @access  Private
// ─────────────────────────────────────────────
exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (id === "read-all") {
      // Mark all unread notifications for this user as read
      await Notification.updateMany(
        { user_id: req.user._id, is_read: false },
        { $set: { is_read: true, read_at: new Date() } }
      );

      return res.status(200).json({
        success: true,
        message: "All notifications marked as read",
      });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: id, user_id: req.user._id },
      { $set: { is_read: true, read_at: new Date() } },
      { new: true }
    ).lean();

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
      data: notification,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Delete a notification
// @route   DELETE /api/notifications/:id
// @access  Private
// ─────────────────────────────────────────────
exports.deleteNotification = async (req, res, next) => {
  try {
    const result = await Notification.deleteOne({
      _id: req.params.id,
      user_id: req.user._id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    next(error);
  }
};

const { enqueueNotification } = require("../queues/notification.queue");

// ─────────────────────────────────────────────
// Internal Helper: Send Notification to a user (Dispatches to BullMQ queue)
// ─────────────────────────────────────────────
exports.sendNotification = async ({ user_id, type, title, message, data = {} }) => {
  return await enqueueNotification({
    user_id,
    type,
    title,
    message,
    data,
  });
};

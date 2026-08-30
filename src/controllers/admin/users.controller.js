/**
 * admin/users.controller.js
 *
 * Optimisation notes:
 *   - getUsers: lean() + pagination + parallel count+data
 *   - getUserById: lean() + projection, no full doc hydration
 *   - updateUserStatus: atomic findByIdAndUpdate — no fetch+save
 *   - deleteUser: existence + paired-device check fused into query;
 *     soft-delete pattern preferred (status: "banned") over hard delete
 *     to preserve audit trail and foreign key integrity.
 */
const User   = require("../../models/User");
const Device = require("../../models/device.model");
const audit  = require("../../security/auditLogger");

const USER_PROJECTION = "name email phonenumber role status status_reason avatar auth_provider createdAt updatedAt";

// ─────────────────────────────────────────────
// @desc    List users with filters + pagination
// @route   GET /api/admin/users?page=1&limit=20&role=USER&status=active&search=john
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getUsers = async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip   = (page - 1) * limit;

    const filter = {};
    if (req.query.role   && ["ADMIN", "USER"].includes(req.query.role.toUpperCase()))
      filter.role = req.query.role.toUpperCase();
    if (req.query.status && ["active", "suspended", "banned"].includes(req.query.status))
      filter.status = req.query.status;
    // Full-text–style name/email search using case-insensitive regex
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ name: rx }, { email: rx }];
    }

    // Parallel count + data — saves one serial round-trip
    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(USER_PROJECTION)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: users.length,
      data: users,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get single user by ID + their paired device
// @route   GET /api/admin/users/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getUserById = async (req, res, next) => {
  try {
    // Fetch user + paired device in parallel
    const [user, pairedDevice] = await Promise.all([
      User.findById(req.params.id).select(USER_PROJECTION).lean(),
      Device.findOne({ linked_to: req.params.id, is_paired: true })
        .select("devicename device_id BLE_ADDRESS firmware_version linked_date is_blocked")
        .lean(),
    ]);

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    res.status(200).json({ success: true, data: { ...user, paired_device: pairedDevice || null } });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Suspend / ban / reactivate a user
// @route   PATCH /api/admin/users/:id/status
// @access  Private/Admin
// Body: { status: "active"|"suspended"|"banned", reason?: string }
// ─────────────────────────────────────────────
exports.updateUserStatus = async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    const validStatuses = ["active", "suspended", "banned"];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Prevent admin from suspending themselves
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "You cannot change your own account status" });
    }

    // Atomic update — no fetch+save needed
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { status, status_reason: reason || null } },
      { new: true, select: "name email role status status_reason" }
    ).lean();

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    audit.log({
      req, category: "ADMIN", action: "USER_STATUS_UPDATE", status: "SUCCESS",
      resource_type: "User", resource_id: user._id,
      message: `User ${user.email} status → ${status}${reason ? ` (${reason})` : ""}`,
      metadata: { status, reason },
    });

    res.status(200).json({ success: true, message: `User status updated to ${status}`, data: user });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Hard-delete a user (Admin Only)
// @route   DELETE /api/admin/users/:id
// @access  Private/Admin
// Note: Blocked if user has an active paired device.
// ─────────────────────────────────────────────
exports.deleteUser = async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account" });
    }

    /**
     * OPTIMISATION: check existence + paired device in parallel.
     * Only select _id/_is_paired — no full document needed for either check.
     */
    const [user, pairedDevice] = await Promise.all([
      User.findById(req.params.id).select("_id email name").lean(),
      Device.exists({ linked_to: req.params.id, is_paired: true }),
    ]);

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (pairedDevice) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete user with an active paired device. Force-unlink the device first.",
      });
    }

    // Parallel: delete user + their saved addresses
    const SavedAddress = require("../../models/Saved_address.model");
    await Promise.all([
      User.deleteOne({ _id: req.params.id }),
      SavedAddress.deleteMany({ user_id: req.params.id }),
    ]);

    audit.log({
      req, category: "ADMIN", action: "USER_DELETE", status: "SUCCESS",
      resource_type: "User", resource_id: req.params.id,
      message: `User deleted: ${user.email}`,
    });

    res.status(200).json({ success: true, message: "User and associated data deleted successfully" });
  } catch (error) {
    next(error);
  }
};

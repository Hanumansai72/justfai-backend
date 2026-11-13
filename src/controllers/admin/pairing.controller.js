/**
 * admin/pairing.controller.js
 *
 * Optimisation notes:
 *   - getPairingRequests: lean() + compound index { linked_to, is_paired } hit
 *     + parallel count+data fetch
 *   - forceUnpairDevice: delegates to the same atomic $set+$unset pattern
 *     used in devices.controller to keep logic DRY.
 */
const Device = require("../../models/device.model");
const audit  = require("../../security/auditLogger");
const mongoose = require('mongoose');
const User = require('../../models/User');
const cache = require('../../services/cache.service');
const { generateRandomCode, generateDeviceHash, hashString } = require('../../utils/deviceCrypto');

// Admin assignment establishes ownership; no device setup credential is needed.
exports.assignDevice = async (req, res, next) => {
  try {
    const userId = req.body?.user_id;
    if (!mongoose.isObjectIdOrHexString(req.params.id) ||
        !mongoose.isObjectIdOrHexString(userId)) {
      return res.status(400).json({ success: false, message: 'Choose a valid device and registered user.' });
    }
    const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
    await mongoose.connection.transaction(async session => {
      // Serialize all assignment/pairing attempts for this account.
      const account = await User.updateOne({ _id: userId, role: 'USER', status: 'active' },
        { $inc: { device_link_version: 1 } }, { session });
      if (!account.matchedCount) throw conflict('Choose an active registered user.');
      const other = await Device.findOne({ linked_to: userId, is_paired: true, _id: { $ne: req.params.id } })
        .session(session).select('_id').lean();
      if (other) throw conflict('This user already has a device. Unlink it first.');
      const device = await Device.findById(req.params.id).session(session).select('+device_secret');
      if (!device || !device.is_active || device.is_blocked || device.is_retired) {
        throw conflict('Device must be active, unblocked, and not retired.');
      }
      if (device.is_paired && String(device.linked_to) === String(userId)) return;
      if (device.is_paired || device.linked_to) throw conflict('Device already belongs to a user. Unlink it first.');
      const secret = device.device_secret || process.env.DEVICE_SECRET;
      if (!secret || !device.BLE_ADDRESS) throw conflict('Device registration is incomplete.');
      const code = generateRandomCode(6);
      const assigned = await Device.findOneAndUpdate({ _id: device._id, is_paired: false,
        linked_to: null, is_active: true, is_blocked: false, is_retired: false }, {
        $set: { linked_to: userId, linked_date: new Date(), is_paired: true,
          device_hash: generateDeviceHash(device.BLE_ADDRESS, code, secret), pairing_code: hashString(code) },
        $unset: { unlink_date: '', unlink_by: '', unlink_otp: '', unlink_otp_expires: '' },
      }, { session, new: true });
      if (!assigned) throw conflict('Device ownership changed. Refresh and try again.');
    });
    await cache.invalidate(['users', 'devices', 'pairing', 'support', 'dashboard']);
    audit.log({ req, category: 'ADMIN', action: 'DEVICE_ASSIGN', status: 'SUCCESS',
      resource_type: 'Device', resource_id: req.params.id,
      message: 'Admin assigned device to registered user', metadata: { user_id: userId } });
    res.json({ success: true, message: 'Device assigned successfully.' });
  } catch (error) { next(error); }
};

// ─────────────────────────────────────────────
// @desc    Get active pairing requests / paired devices log
// @route   GET /api/admin/pairing?page=1&limit=10&since=2024-01-01
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getPairingRequests = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.max(1, Math.min(10, parseInt(req.query.limit, 10) || 10));
    const skip  = (page - 1) * limit;

    // Optional date range filter
    const filter = { is_paired: true };
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!isNaN(since.getTime())) filter.linked_date = { $gte: since };
    }
    if (req.query.until) {
      const until = new Date(req.query.until);
      if (!isNaN(until.getTime())) {
        filter.linked_date = { ...filter.linked_date, $lte: until };
      }
    }

    // Parallel count + data — hits compound index { linked_to, is_paired }
    const [total, pairings] = await Promise.all([
      Device.countDocuments(filter),
      Device.find(filter)
        .select("devicename device_id BLE_ADDRESS linked_to linked_date no_of_connection firmware_version is_blocked")
        .populate("linked_to", "name email phonenumber")
        .sort({ linked_date: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: pairings.length,
      data: pairings,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Admin force-unpair any device (no OTP/hash required)
// @route   PATCH /api/admin/pairing/:id/force-unpair
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.forceUnpairDevice = async (req, res, next) => {
  try {
    // Light read — only check what we need
    const device = await Device.findById(req.params.id)
      .select("_id devicename device_id BLE_ADDRESS is_paired linked_to")
      .lean();

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    if (!device.is_paired || !device.linked_to) {
      return res.status(400).json({ success: false, message: "Device is not currently paired" });
    }

    /**
     * OPTIMISATION: single atomic $set + $unset — same pattern as forceUnlinkDevice
     * in devices.controller. All credential invalidation happens in one write.
     */
    await Device.updateOne(
      { _id: device._id },
      {
        $set: {
          is_paired:   false,
          linked_to:   null,
          unlink_date: new Date(),
          unlink_by:   req.user._id,
        },
        $unset: { device_hash: "", pairing_code: "", unlink_otp: "", unlink_otp_expires: "" },
      }
    );

    audit.log({
      req, category: "ADMIN", action: "DEVICE_FORCE_UNPAIR", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Admin force-unpaired: ${device.BLE_ADDRESS} from user ${device.linked_to}`,
      metadata: { device_id: device.device_id, previous_owner: device.linked_to },
    });

    res.status(200).json({
      success: true,
      message: "Device force-unpaired successfully",
      data: { _id: device._id, device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS, is_paired: false },
    });
  } catch (error) {
    next(error);
  }
};

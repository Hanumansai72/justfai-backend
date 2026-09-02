/**
 * admin/devices.controller.js
 *
 * Optimisation notes:
 *   - getDevices: lean() + pagination + parallel count+data + compound index hit
 *   - blockDevice / unblockDevice: single atomic updateOne — no fetch+save
 *   - forceUnlinkDevice: atomic $set+$unset in ONE write operation
 *   - retireDevice: guard + force-unlink + retire in correct order, atomic final write
 *   - updateDevice: findByIdAndUpdate avoids double round-trip
 */
const Device = require("../../models/device.model");
const audit  = require("../../security/auditLogger");
const { sendNotification } = require("../notification.controller");
const { formatBleAddress, generateRandomCode, findDeviceByIdentifier } = require("../../utils/deviceCrypto");

const DEVICE_PROJECTION = "-pairing_code -unlink_otp -__v";

// ─────────────────────────────────────────────
// @desc    Register / provision a new device (Admin)
// @route   POST /api/admin/devices
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.registerDevice = async (req, res, next) => {
  try {
    const { devicename, device_version, firmware_version, serialnumber, BLE_ADDRESS, device_id } = req.body;
    const normalizedBle = formatBleAddress(BLE_ADDRESS);

    const orConditions = [];
    if (normalizedBle) orConditions.push({ BLE_ADDRESS: normalizedBle });
    if (device_id)     orConditions.push({ device_id });
    if (serialnumber)  orConditions.push({ serialnumber });

    if (orConditions.length === 0) {
      return res.status(400).json({ success: false, message: "Provide BLE_ADDRESS, device_id, or serialnumber" });
    }

    // .exists() — cheaper than .findOne() when we only need a boolean + _id
    const duplicate = await Device.exists({ $or: orConditions });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "Device with these identifiers already exists",
        existing_id: duplicate._id,
      });
    }

    const uniqueDeviceSecret = generateRandomCode(32).toLowerCase();

    const device = await Device.create({
      devicename:       devicename || "Smart Ride Device",
      device_version,
      firmware_version: firmware_version || device_version || null,
      serialnumber,
      BLE_ADDRESS:      normalizedBle,
      device_id:        device_id || `DEV-${generateRandomCode(8)}`,
      device_secret:    uniqueDeviceSecret,
      is_paired:  false,
      is_active:  true,
      is_blocked: false,
      is_retired: false,
    });

    audit.log({
      req, category: "ADMIN", action: "DEVICE_REGISTER", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Device provisioned: ${device.device_id}`,
    });

    res.status(201).json({ success: true, message: "Device registered successfully", data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    List all devices with filters + pagination
// @route   GET /api/admin/devices?page=1&limit=20&is_paired=true&is_blocked=false&search=DEV-
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getDevices = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.is_paired  !== undefined) filter.is_paired  = req.query.is_paired  === "true";
    if (req.query.is_blocked !== undefined) filter.is_blocked = req.query.is_blocked === "true";
    if (req.query.is_retired !== undefined) filter.is_retired = req.query.is_retired === "true";
    if (req.query.is_active  !== undefined) filter.is_active  = req.query.is_active  === "true";
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ device_id: rx }, { devicename: rx }, { BLE_ADDRESS: rx }, { serialnumber: rx }];
    }

    // Parallel count + data fetch
    const [total, devices] = await Promise.all([
      Device.countDocuments(filter),
      Device.find(filter)
        .select(DEVICE_PROJECTION)
        .populate("linked_to",  "name email")
        .populate("blocked_by", "name email")
        .populate("retired_by", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: devices.length,
      data: devices,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get single device by any identifier
// @route   GET /api/admin/devices/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getDeviceById = async (req, res, next) => {
  try {
    const device = await findDeviceByIdentifier(Device, req.params.id, DEVICE_PROJECTION, [
      { path: "linked_to",  select: "name email phonenumber" },
      { path: "unlink_by",  select: "name email" },
      { path: "blocked_by", select: "name email" },
      { path: "retired_by", select: "name email" },
    ]);

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    res.status(200).json({ success: true, data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update device metadata
// @route   PUT /api/admin/devices/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.updateDevice = async (req, res, next) => {
  try {
    const allowed = {};
    const { devicename, device_version, serialnumber, is_active } = req.body;
    if (devicename     !== undefined) allowed.devicename     = devicename;
    if (device_version !== undefined) allowed.device_version = device_version;
    if (serialnumber   !== undefined) allowed.serialnumber   = serialnumber;
    if (is_active      !== undefined) allowed.is_active      = is_active;

    if (!Object.keys(allowed).length) {
      return res.status(400).json({ success: false, message: "No updatable fields provided" });
    }

    const device = await Device.findByIdAndUpdate(
      req.params.id,
      { $set: allowed },
      { new: true, runValidators: true, select: DEVICE_PROJECTION }
    ).lean();

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    res.status(200).json({ success: true, message: "Device updated", data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Block a device (prevents new pairings, BLE denied)
// @route   PATCH /api/admin/devices/:id/block
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.blockDevice = async (req, res, next) => {
  try {
    const { reason } = req.body;

    const existing = await Device.findById(req.params.id)
      .select("_id devicename device_id BLE_ADDRESS is_paired linked_to")
      .lean();

    if (!existing) return res.status(404).json({ success: false, message: "Device not found" });

    const previousOwner = existing.linked_to;

    // Atomic update: block, deactivate, and force-unpair from any linked account
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          is_blocked:   true,
          block_reason: reason || null,
          blocked_at:   new Date(),
          blocked_by:   req.user._id,
          is_active:    false,
          is_paired:    false,
          linked_to:    null,
          unlink_date:  new Date(),
          unlink_by:    req.user._id,
        },
        $unset: {
          device_hash:        "",
          pairing_code:       "",
          unlink_otp:         "",
          unlink_otp_expires: "",
        },
      },
      { new: true, select: "devicename device_id BLE_ADDRESS is_blocked block_reason blocked_at is_paired" }
    ).lean();

    audit.log({
      req, category: "ADMIN", action: "DEVICE_BLOCK", status: "SUCCESS",
      resource_type: "Device", resource_id: req.params.id,
      message: `Device blocked and unlinked: ${device.device_id} — ${reason || "no reason"}`,
    });

    // Notify previously linked user that device was blocked and disconnected
    if (previousOwner) {
      await sendNotification({
        user_id: previousOwner,
        type: "DEVICE_BLOCKED",
        title: "Device Blocked & Disconnected",
        message: `Your device (${device.devicename || device.BLE_ADDRESS}) has been blocked by an administrator and disconnected from your account.`,
        data: { device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS, status: "BLOCKED" },
      });
    }

    res.status(200).json({ success: true, message: "Device blocked and force-unlinked successfully", data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Unblock a device
// @route   PATCH /api/admin/devices/:id/unblock
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.unblockDevice = async (req, res, next) => {
  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      {
        $set:   { is_blocked: false, is_active: true },
        $unset: { block_reason: "", blocked_at: "", blocked_by: "" },
      },
      { new: true, select: "devicename device_id BLE_ADDRESS is_blocked is_active" }
    ).lean();

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    audit.log({
      req, category: "ADMIN", action: "DEVICE_UNBLOCK", status: "SUCCESS",
      resource_type: "Device", resource_id: req.params.id,
      message: `Device unblocked: ${device.device_id}`,
    });

    res.status(200).json({ success: true, message: "Device unblocked successfully", data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Force-unlink a device without cryptographic verification (Admin override)
// @route   PATCH /api/admin/devices/:id/force-unlink
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.forceUnlinkDevice = async (req, res, next) => {
  try {
    // Only select fields needed to verify state — not the full document
    const device = await Device.findById(req.params.id)
      .select("_id devicename device_id BLE_ADDRESS is_paired linked_to")
      .lean();

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });

    if (!device.is_paired) {
      return res.status(400).json({ success: false, message: "Device is not currently paired" });
    }

    /**
     * OPTIMISATION: single atomic $set + $unset — wipes all pairing credentials
     * in one write. No fetch+mutate+save round-trip.
     */
    await Device.updateOne(
      { _id: device._id },
      {
        $set:   { is_paired: false, linked_to: null, unlink_date: new Date(), unlink_by: req.user._id },
        $unset: { device_hash: "", pairing_code: "", unlink_otp: "", unlink_otp_expires: "" },
      }
    );

    audit.log({
      req, category: "ADMIN", action: "DEVICE_FORCE_UNLINK", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Force-unlinked: ${device.BLE_ADDRESS} (was linked to ${device.linked_to})`,
      metadata: { device_id: device.device_id, previous_owner: device.linked_to },
    });

    res.status(200).json({
      success: true,
      message: "Device force-unlinked successfully",
      data: { _id: device._id, device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Retire a device permanently (end-of-life)
// @route   PATCH /api/admin/devices/:id/retire
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.retireDevice = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const device = await Device.findById(req.params.id)
      .select("_id devicename device_id BLE_ADDRESS is_paired is_retired")
      .lean();

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });
    if (device.is_retired) {
      return res.status(400).json({ success: false, message: "Device is already retired" });
    }

    /**
     * OPTIMISATION: single atomic write handles all state changes:
     *   - Force-unlinks if currently paired
     *   - Marks as retired, inactive, blocked
     *   - Clears all security credentials
     */
    await Device.updateOne(
      { _id: device._id },
      {
        $set: {
          is_retired:  true,
          is_active:   false,
          is_blocked:  true,
          is_paired:   false,
          linked_to:   null,
          unlink_date: new Date(),
          unlink_by:   req.user._id,
          retired_at:  new Date(),
          retired_by:  req.user._id,
          block_reason: reason || "Device retired",
        },
        $unset: { device_hash: "", pairing_code: "", unlink_otp: "", unlink_otp_expires: "" },
      }
    );

    audit.log({
      req, category: "ADMIN", action: "DEVICE_RETIRE", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Device retired: ${device.device_id}${reason ? ` — ${reason}` : ""}`,
    });

    res.status(200).json({
      success: true,
      message: "Device retired successfully",
      data: { _id: device._id, device_id: device.device_id, is_retired: true },
    });
  } catch (error) {
    next(error);
  }
};

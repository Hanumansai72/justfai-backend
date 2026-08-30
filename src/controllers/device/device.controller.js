/**
 * device/device.controller.js — Core CRUD
 *
 * Query optimisation notes:
 *   - Read-only endpoints use .lean() for ~2–3× throughput gain
 *   - getDevice chains .populate() inside findDeviceByIdentifier → single round-trip
 *   - updateDevice uses findByIdAndUpdate → eliminates fetch-then-save pattern
 *   - deleteDevice checks is_paired using findOne with projection → cheaper than full doc
 */
const Device = require("../../models/device.model");
const { formatBleAddress, generateRandomCode, findDeviceByIdentifier } = require("../../utils/deviceCrypto");

/** Fields safe to return to the client */
const DEVICE_PROJECTION = "-pairing_code -unlink_otp -device_hash -__v";

// ─────────────────────────────────────────────
// @desc    Register / provision a new hardware device
// @route   POST /api/devices
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.registerDevice = async (req, res, next) => {
  try {
    const { devicename, device_version, firmware_version, serialnumber, BLE_ADDRESS, device_id } = req.body;
    const normalizedBle = formatBleAddress(BLE_ADDRESS);

    // Build $or only from the identifiers that were actually provided
    const orConditions = [];
    if (normalizedBle) orConditions.push({ BLE_ADDRESS: normalizedBle });
    if (device_id)     orConditions.push({ device_id });
    if (serialnumber)  orConditions.push({ serialnumber });

    /**
     * OPTIMISATION: .exists() returns null or { _id } — no full document fetch.
     * Much cheaper than .findOne() when we only need to know if a doc exists.
     */
    const duplicate = await Device.exists({ $or: orConditions });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "A device with that BLE_ADDRESS, device_id, or serialnumber already exists",
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
      is_paired:        false,
      is_active:        true,
    });

    res.status(201).json({ success: true, message: "Device registered successfully", data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get a device by _id / BLE_ADDRESS / device_id / device_hash
// @route   GET /api/devices/:id
// @access  Private (Owner or Admin)
// ─────────────────────────────────────────────
exports.getDevice = async (req, res, next) => {
  try {
    const device = await findDeviceByIdentifier(
      Device,
      req.params.id,
      DEVICE_PROJECTION,
      [
        { path: "linked_to", select: "name email phonenumber" },
        { path: "unlink_by", select: "name email phonenumber" },
      ]
    );

    if (!device) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    // IDOR Protection: Non-admins can ONLY view the device if it is linked to them
    const isOwner = device.linked_to && (device.linked_to._id ? device.linked_to._id.toString() : device.linked_to.toString()) === req.user._id.toString();
    const isAdmin = req.user.role === "ADMIN";

    if (!isOwner && !isAdmin) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    res.status(200).json({ success: true, data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get the active paired device of the logged-in user
// @route   GET /api/devices/my-device
// @access  Private
// ─────────────────────────────────────────────
exports.getMyDevice = async (req, res, next) => {
  try {
    /**
     * OPTIMISATION: hits the compound index { linked_to, is_paired } defined on the
     * Device model. .lean() for read-only response.
     */
    const device = await Device.findOne({ linked_to: req.user._id, is_paired: true })
      .select(DEVICE_PROJECTION)
      .populate("linked_to", "name email phonenumber")
      .lean();

    res.status(200).json({
      success: true,
      data:    device || null,
      message: device ? undefined : "No device is currently paired with this account",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update editable device metadata
// @route   PUT /api/devices/:id
// @access  Private (Owner or Admin)
// ─────────────────────────────────────────────
exports.updateDevice = async (req, res, next) => {
  try {
    const isAdmin = req.user.role === "ADMIN";

    // Verify ownership before applying update
    const existing = await findDeviceByIdentifier(Device, req.params.id, "linked_to");
    if (!existing) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    const isOwner = existing.linked_to && existing.linked_to.toString() === req.user._id.toString();
    if (!isOwner && !isAdmin) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    const allowed = {};
    const { devicename, device_version, serialnumber, is_active } = req.body;

    // Normal users may only change custom device nickname/devicename
    if (devicename !== undefined) allowed.devicename = devicename;

    // Privileged hardware parameters can only be updated by admins
    if (isAdmin) {
      if (device_version !== undefined) allowed.device_version = device_version;
      if (serialnumber   !== undefined) allowed.serialnumber   = serialnumber;
      if (is_active      !== undefined) allowed.is_active      = is_active;
    }

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ success: false, message: "No authorized updatable fields provided" });
    }

    const device = await Device.findByIdAndUpdate(
      existing._id,
      { $set: allowed },
      { new: true, runValidators: true, select: DEVICE_PROJECTION }
    ).lean();

    res.status(200).json({ success: true, message: "Device updated successfully", data: device });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Delete / decommission a device
// @route   DELETE /api/devices/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.deleteDevice = async (req, res, next) => {
  try {
    /**
     * OPTIMISATION: select only is_paired — no need to fetch the entire document
     * just to check one boolean before deletion.
     */
    const device = await Device.findById(req.params.id).select("is_paired");
    if (!device) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (device.is_paired) {
      return res.status(400).json({ success: false, message: "Cannot delete a paired device. Unlink it first." });
    }

    await device.deleteOne();
    res.status(200).json({ success: true, message: "Device deleted successfully" });
  } catch (error) {
    next(error);
  }
};

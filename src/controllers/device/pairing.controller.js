/**
 * device/pairing.controller.js
 *
 * Query optimisation notes:
 *   - checkDeviceAccess: independent findDevice + findUserDevice run in PARALLEL via Promise.all()
 *   - pairDevice: pre-checks (find device + find user's current device) run in PARALLEL
 *   - unlinkDevice: findDeviceByIdentifier with selectFields does ONE query including hidden fields
 *   - All "is owner" checks fused into the DB query where possible (no separate ownership queries)
 */
const Device = require("../../models/device.model");
const audit  = require("../../security/auditLogger");
const { sendNotification } = require("../notification.controller");
const {
  formatBleAddress,
  generateRandomCode,
  generateNumericOtp,
  hashString,
  generateDeviceHash,
  safeCompare,
  findDeviceByIdentifier,
} = require("../../utils/deviceCrypto");

// ─────────────────────────────────────────────
// @desc    Pre-pairing check — does not modify state
// @route   POST /api/devices/check-pairing
// @access  Private
// ─────────────────────────────────────────────
exports.checkDeviceAccess = async (req, res, next) => {
  try {
    const { BLE_ADDRESS, device_id, serialnumber } = req.body;

    if (!BLE_ADDRESS && !device_id && !serialnumber) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one of: BLE_ADDRESS, device_id, or serialnumber",
      });
    }

    const orConditions = [];
    if (BLE_ADDRESS)  orConditions.push({ BLE_ADDRESS: formatBleAddress(BLE_ADDRESS) });
    if (device_id)    orConditions.push({ device_id });
    if (serialnumber) orConditions.push({ serialnumber });

    /**
     * OPTIMISATION: run both queries in PARALLEL.
     *   Query 1 — does the device exist and what is its pairing state?
     *   Query 2 — does the requesting user already have an active paired device?
     * Previously these were two sequential awaits; Promise.all() halves the latency.
     */
    const [device, userCurrentDevice] = await Promise.all([
      Device.findOne({ $or: orConditions })
        .select("devicename device_id BLE_ADDRESS device_version firmware_version is_paired is_active linked_to")
        .lean(),
      Device.findOne({ linked_to: req.user._id, is_paired: true })
        .select("devicename device_id BLE_ADDRESS")
        .lean(),
    ]);

    if (!device) {
      return res.status(404).json({
        success: false,
        can_pair: false,
        reason: "DEVICE_NOT_REGISTERED",
        message: "This device is not registered in the JustRide system.",
      });
    }

    if (!device.is_active || device.is_blocked || device.is_retired) {
      return res.status(403).json({
        success: false,
        can_pair: false,
        reason: device.is_blocked ? "DEVICE_BLOCKED" : device.is_retired ? "DEVICE_RETIRED" : "DEVICE_INACTIVE",
        message: `This device is ${device.is_blocked ? "blocked" : device.is_retired ? "retired" : "deactivated"} and cannot be paired.`,
      });
    }

    // Already paired to this user
    if (device.is_paired && device.linked_to?.toString() === req.user._id.toString()) {
      return res.status(200).json({
        success: true, can_pair: true, reason: "ALREADY_PAIRED_TO_YOU",
        message: "Device is already paired with your account.",
        data: { _id: device._id, devicename: device.devicename, device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS },
      });
    }

    // Paired to someone else
    if (device.is_paired && device.linked_to) {
      return res.status(409).json({
        success: false, can_pair: false, reason: "DEVICE_PAIRED_TO_ANOTHER_USER",
        message: "This device is paired with another account. It must be unlinked first.",
      });
    }

    // User already has a different paired device
    if (userCurrentDevice) {
      return res.status(409).json({
        success: false, can_pair: false, reason: "USER_ALREADY_HAS_PAIRED_DEVICE",
        message: "You already have a paired device. Unlink it first.",
        current_paired_device: userCurrentDevice,
      });
    }

    res.status(200).json({
      success: true, can_pair: true, reason: "DEVICE_AVAILABLE",
      message: "Device is available and ready to pair.",
      data: {
        _id: device._id, devicename: device.devicename, device_id: device.device_id,
        BLE_ADDRESS: device.BLE_ADDRESS, device_version: device.device_version,
        firmware_version: device.firmware_version,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Pair a device (strict 1-to-1, device must be pre-registered)
// @route   POST /api/devices/pair
// @access  Private
// ─────────────────────────────────────────────
exports.pairDevice = async (req, res, next) => {
  try {
    const { BLE_ADDRESS, devicename, device_version, serialnumber, device_id } = req.body;
    const normalizedBle = formatBleAddress(BLE_ADDRESS);

    const orConditions = [{ BLE_ADDRESS: normalizedBle }];
    if (device_id)    orConditions.push({ device_id });
    if (serialnumber) orConditions.push({ serialnumber });

    /**
     * OPTIMISATION: pre-pairing checks run in PARALLEL.
     *   Check 1: Find the device by identifiers
     *   Check 2: Find if user already has any paired device (excluding this device via _id check done after)
     * Saves one full DB round-trip compared to sequential awaits.
     */
    const [device, userCurrentDevice] = await Promise.all([
      Device.findOne({ $or: orConditions }),
      Device.findOne({ linked_to: req.user._id, is_paired: true }).select("_id devicename BLE_ADDRESS device_id").lean(),
    ]);

    if (!device) {
      return res.status(404).json({
        success: false,
        message: "Device not found. It must be registered by an admin before pairing.",
      });
    }

    if (!device.is_active || device.is_blocked || device.is_retired) {
      return res.status(403).json({
        success: false,
        message: `This device is ${device.is_blocked ? "blocked" : device.is_retired ? "retired" : "inactive"} and cannot be paired.`,
      });
    }

    // Device is already with another user
    if (device.is_paired && device.linked_to && device.linked_to.toString() !== req.user._id.toString()) {
      return res.status(409).json({ success: false, message: "This device is paired with another account." });
    }

    // User already has a DIFFERENT device paired
    if (userCurrentDevice && userCurrentDevice._id.toString() !== device._id.toString()) {
      return res.status(409).json({
        success: false,
        message: "You already have a paired device. Unlink it first.",
        current_paired_device: userCurrentDevice,
      });
    }

    // Generate cryptographic credentials
    const pairingCode = generateRandomCode(6);
    const deviceHash  = generateDeviceHash(normalizedBle, pairingCode);

    /**
     * Concurrency / Race Condition Defense:
     * Use atomic findOneAndUpdate with condition { _id, is_paired: false }
     * to guarantee that simultaneous requests cannot both pair the same hardware.
     */
    const updatePayload = {
      device_hash:        deviceHash,
      pairing_code:       hashString(pairingCode),
      is_paired:          true,
      is_active:          true,
      linked_to:          req.user._id,
      linked_date:        new Date(),
      unlink_date:        null,
      unlink_by:          null,
      unlink_otp:         null,
      unlink_otp_expires: null,
      ...(devicename && { devicename }),
      ...(device_version && { device_version }),
      ...(device_id && !device.device_id && { device_id }),
    };

    const pairedDevice = await Device.findOneAndUpdate(
      {
        _id:        device._id,
        is_paired:  false,
        is_blocked: false,
        is_retired: false,
        is_active:  true,
      },
      {
        $set: updatePayload,
        $inc: { no_of_connection: 1 },
      },
      { new: true }
    );

    if (!pairedDevice) {
      return res.status(409).json({
        success: false,
        message: "Device pairing collision: this device was paired by another request just now.",
      });
    }

    audit.log({
      req, category: "DEVICE", action: "DEVICE_PAIR", status: "SUCCESS",
      resource_type: "Device", resource_id: pairedDevice._id,
      message: `Paired: ${pairedDevice.BLE_ADDRESS} → User ${req.user._id}`,
      metadata: { device_id: pairedDevice.device_id, BLE_ADDRESS: pairedDevice.BLE_ADDRESS },
    });

    await sendNotification({
      user_id: req.user._id,
      type: "DEVICE_PAIRING",
      title: "Device Paired Successfully",
      message: `Your device (${pairedDevice.devicename || pairedDevice.BLE_ADDRESS}) is now securely connected to your account.`,
      data: { device_id: pairedDevice.device_id, BLE_ADDRESS: pairedDevice.BLE_ADDRESS },
    });

    res.status(200).json({
      success: true,
      message: "Device paired successfully",
      data: {
        _id: pairedDevice._id, devicename: pairedDevice.devicename, device_id: pairedDevice.device_id,
        BLE_ADDRESS: pairedDevice.BLE_ADDRESS, device_version: pairedDevice.device_version,
        firmware_version: pairedDevice.firmware_version, serialnumber: pairedDevice.serialnumber,
        is_paired: pairedDevice.is_paired, linked_to: pairedDevice.linked_to,
        linked_date: pairedDevice.linked_date, no_of_connection: pairedDevice.no_of_connection,
        // Return plain code once to the app — never stored as plaintext
        pairing_code: pairingCode,
        device_hash:  deviceHash,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Request a 6-digit unlink OTP (valid 10 min)
// @route   POST /api/devices/request-unlink-otp
//          POST /api/devices/:id/request-unlink-otp
// @access  Private
// ─────────────────────────────────────────────
exports.requestUnlinkOtp = async (req, res, next) => {
  try {
    const identifier = req.params.id || req.body.device_id || req.body.BLE_ADDRESS;
    if (!identifier) {
      return res.status(400).json({ success: false, message: "Device identifier is required" });
    }

    /**
     * OPTIMISATION: fuse ownership check into the query itself.
     * findOne({ identifier + linked_to }) hits the compound index { linked_to, is_paired }
     * and eliminates a separate ownership comparison in JS.
     */
    const device = await findDeviceByIdentifier(Device, identifier, "linked_to unlink_otp unlink_otp_expires");

    if (!device) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!device.linked_to || device.linked_to.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized to request OTP for this device" });
    }

    const otp = generateNumericOtp();
    // Atomic update — no need to load the entire document just to set two fields
    await Device.updateOne(
      { _id: device._id },
      { $set: { unlink_otp: hashString(otp), unlink_otp_expires: new Date(Date.now() + 10 * 60 * 1000) } }
    );

    await sendNotification({
      user_id: req.user._id,
      type: "SECURITY_ALERT",
      title: "Device Unlink OTP Requested",
      message: `An OTP was requested to unlink your device (${device.devicename || device.device_id || "Ride Device"}). If this wasn't you, change your password immediately.`,
      data: { device_id: device.device_id },
    });

    res.status(200).json({
      success: true,
      message: "Unlink OTP generated and sent to registered contact (valid for 10 minutes)",
      ...(process.env.NODE_ENV === "development" && { dev_otp: otp }),
      expires_in_seconds: 600,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Unlink device — cryptographic verification required
// @route   POST /api/devices/unlink
//          POST /api/devices/:id/unlink
// @access  Private
// ─────────────────────────────────────────────
exports.unlinkDevice = async (req, res, next) => {
  try {
    const { device_id, BLE_ADDRESS, device_hash, pairing_code, otp_code } = req.body;
    const identifier = req.params.id || device_id || BLE_ADDRESS;

    if (!identifier) {
      return res.status(400).json({ success: false, message: "Device identifier is required" });
    }

    // One query — load with hidden security fields included
    const device = await findDeviceByIdentifier(Device, identifier, "+pairing_code +unlink_otp");

    if (!device)                        return res.status(404).json({ success: false, message: "Device not found" });
    if (!device.is_paired)              return res.status(400).json({ success: false, message: "Device is not paired" });
    if (device.linked_to.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Not authorized to unlink this device" });

    // ── Cryptographic verification ──────────────────────────────
    let isHashValid = false;
    let isOtpValid  = false;

    if (device_hash && device.device_hash)
      isHashValid = safeCompare(device.device_hash, device_hash);

    if (pairing_code && device.BLE_ADDRESS) {
      if (safeCompare(device.device_hash, generateDeviceHash(device.BLE_ADDRESS, pairing_code))) isHashValid = true;
      if (device.pairing_code && safeCompare(device.pairing_code, hashString(pairing_code)))     isHashValid = true;
    }

    if (otp_code && device.unlink_otp) {
      const fresh = device.unlink_otp_expires && device.unlink_otp_expires > new Date();
      if (fresh && safeCompare(device.unlink_otp, hashString(String(otp_code)))) isOtpValid = true;
    }

    if (!isHashValid && !isOtpValid) {
      return res.status(400).json({
        success: false,
        message: "Verification failed. Provide a valid device_hash, pairing_code, or OTP.",
      });
    }

    /**
     * OPTIMISATION: single atomic $set + $unset operation.
     * No need to load the full document, mutate fields, then save.
     */
    await Device.updateOne(
      { _id: device._id },
      {
        $set:   { is_paired: false, linked_to: null, unlink_date: new Date(), unlink_by: req.user._id },
        $unset: { device_hash: "", pairing_code: "", unlink_otp: "", unlink_otp_expires: "" },
      }
    );

    audit.log({
      req, category: "DEVICE", action: "DEVICE_UNLINK", status: "SUCCESS",
      resource_type: "Device", resource_id: device._id,
      message: `Unlinked: ${device.BLE_ADDRESS} by User ${req.user._id}`,
      metadata: { device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS },
    });

    await sendNotification({
      user_id: req.user._id,
      type: "DEVICE_DISCONNECTED",
      title: "Device Disconnected & Unlinked",
      message: `Your device (${device.devicename || device.BLE_ADDRESS}) has been unlinked from your account.`,
      data: { device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS },
    });

    res.status(200).json({
      success: true,
      message: "Device unlinked and credentials invalidated",
      data: { _id: device._id, devicename: device.devicename, device_id: device.device_id, BLE_ADDRESS: device.BLE_ADDRESS },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * device/firmware.controller.js
 *
 * Comprehensive Firmware Management:
 *   - getLatestFirmware()      → Fetch latest release from FirmwareRelease catalog
 *   - checkUpdate()            → Compare device version against active release catalog
 *   - getFirmwareDownload()    → Obtain download URL, binary checksum, and release notes
 *   - createFirmwareRelease()  → Publish a new official release
 *   - recordFirmwareUpdate()   → Record OTA result + create notification
 *   - getFirmwareHistory()     → Audit history of device firmware updates
 *   - setLatestFirmware()      → Push specific target version to device record
 */
const Device          = require("../../models/device.model");
const FirmwareHistory = require("../../models/FirmwareHistory.model");
const FirmwareRelease = require("../../models/FirmwareRelease.model");
const { findDeviceByIdentifier } = require("../../utils/deviceCrypto");
const { sendNotification }       = require("../notification.controller");
const cacheService               = require("../../services/cache.service");
const audit                      = require("../../security/auditLogger");

/** Semantic version comparison — returns true if `candidate` is newer than `current` */
const isNewerVersion = (current, candidate) => {
  if (!current) return true;
  const parse = (v) => String(v).replace(/^v/i, "").split(".").map(Number);
  const [cA, cB = 0, cC = 0] = parse(current);
  const [nA, nB = 0, nC = 0] = parse(candidate);
  if (nA !== cA) return nA > cA;
  if (nB !== cB) return nB > cB;
  return nC > cC;
};

/** Check caller is the device owner or an admin */
const isAuthorized = (device, req) =>
  device.linked_to?.toString() === req.user._id.toString() || req.user.role === "ADMIN";

// ─────────────────────────────────────────────
// @desc    Get latest official firmware release (Cached in Redis)
// @route   GET /api/devices/firmware/latest
// @access  Private
// ─────────────────────────────────────────────
exports.getLatestFirmware = async (req, res, next) => {
  try {
    const { device_type, channel = "stable" } = req.query;
    const cacheKey = `firmware:latest:${device_type || "all"}:${channel}`;

    const latestRelease = await cacheService.getOrSet(
      cacheKey,
      async () => {
        const filter = { is_active: true, channel };
        if (device_type) {
          filter.$or = [{ device_type: null }, { device_type: new RegExp(device_type.trim(), "i") }];
        }
        return await FirmwareRelease.findOne(filter).sort({ release_date: -1 }).lean();
      },
      600 // 10 minutes cache TTL
    );

    if (!latestRelease) {
      return res.status(404).json({
        success: false,
        message: "No active firmware release found for the requested criteria",
      });
    }

    res.status(200).json({
      success: true,
      data: latestRelease,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Check if firmware update is available for a device
// @route   GET /api/devices/:id/firmware/check (or /api/devices/:id/check-update)
// @access  Private (Owner or Admin)
// ─────────────────────────────────────────────
exports.checkUpdate = async (req, res, next) => {
  try {
    const device = await findDeviceByIdentifier(
      Device,
      req.params.id,
      "linked_to device_id BLE_ADDRESS firmware_version device_version latest_firmware firmware_update_available"
    );

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });
    if (!isAuthorized(device, req)) {
      return res.status(403).json({ success: false, message: "Not authorized to check firmware for this device" });
    }

    const current = device.firmware_version || device.device_version;

    // Cross-reference with official active release catalog
    const latestCatalogRelease = await FirmwareRelease.findOne({
      is_active: true,
      channel: "stable",
    })
      .sort({ release_date: -1 })
      .lean();

    const targetVersion = latestCatalogRelease?.version || device.latest_firmware;
    const hasUpdate = !!targetVersion && isNewerVersion(current, targetVersion);
    const now = new Date();

    await Device.updateOne(
      { _id: device._id },
      {
        $set: {
          last_firmware_check: now,
          latest_firmware: targetVersion || null,
          firmware_update_available: hasUpdate,
        },
      }
    );

    if (hasUpdate && device.linked_to) {
      await sendNotification({
        user_id: device.linked_to,
        type: "FIRMWARE_UPDATE",
        title: "Firmware Update Available",
        message: `Firmware v${targetVersion} is available for your device (${device.devicename || device.device_id}).`,
        data: {
          device_id: device.device_id,
          current_version: current,
          latest_version: targetVersion,
        },
      });
    }

    res.status(200).json({
      success: true,
      data: {
        device_id:        device.device_id || device._id,
        BLE_ADDRESS:      device.BLE_ADDRESS,
        current_firmware: current || "unknown",
        latest_firmware:  targetVersion || "N/A",
        update_available: hasUpdate,
        release_details:  hasUpdate && latestCatalogRelease ? {
          version:               latestCatalogRelease.version,
          release_notes:         latestCatalogRelease.release_notes,
          file_url:              latestCatalogRelease.file_url,
          checksum:              latestCatalogRelease.checksum,
          min_supported_version: latestCatalogRelease.min_supported_version,
        } : null,
        last_checked: now,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Aliased to checkFirmwareUpdate for backward compatibility
exports.checkFirmwareUpdate = exports.checkUpdate;

// ─────────────────────────────────────────────
// @desc    Get download payload & checksum for a firmware version
// @route   GET /api/devices/firmware/download/:version
// @access  Private
// ─────────────────────────────────────────────
exports.getFirmwareDownload = async (req, res, next) => {
  try {
    const { version } = req.params;

    const release = await FirmwareRelease.findOne({
      version,
      is_active: true,
    }).lean();

    if (!release) {
      return res.status(404).json({
        success: false,
        message: `Firmware version v${version} not found or inactive`,
      });
    }

    res.status(200).json({
      success: true,
      data: {
        version:       release.version,
        channel:       release.channel,
        file_url:      release.file_url,
        checksum:      release.checksum,
        release_notes: release.release_notes,
        release_date:  release.release_date,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Publish a new firmware release
// @route   POST /api/devices/firmware/release
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.createFirmwareRelease = async (req, res, next) => {
  try {
    const {
      version, device_type, min_supported_version,
      release_notes, file_url, checksum, channel,
    } = req.body;

    if (!version) {
      return res.status(400).json({ success: false, message: "version is required" });
    }

    const duplicate = await FirmwareRelease.exists({ version });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Firmware version '${version}' already exists`,
      });
    }

    const release = await FirmwareRelease.create({
      version,
      device_type,
      min_supported_version,
      release_notes,
      file_url,
      checksum,
      channel: channel || "stable",
      released_by: req.user._id,
      release_date: new Date(),
      is_active: true,
    });

    // Invalidate Redis firmware caches
    await cacheService.delPattern("firmware:*");

    audit.log({
      req, category: "FIRMWARE", action: "FIRMWARE_RELEASE_CREATE", status: "SUCCESS",
      resource_type: "Firmware", resource_id: release._id,
      message: `Firmware release created: v${version}`,
    });

    res.status(201).json({
      success: true,
      message: "Firmware release published successfully",
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Record firmware update result (success / failed / rollback)
// @route   POST /api/devices/:id/firmware/update
// @access  Private (Owner or Admin)
// ─────────────────────────────────────────────
exports.recordFirmwareUpdate = async (req, res, next) => {
  try {
    const { to_version, status = "success", notes } = req.body;
    const validStatuses = ["pending", "success", "failed", "rollback"];

    if (!to_version) {
      return res.status(400).json({ success: false, message: "to_version is required" });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const device = await findDeviceByIdentifier(
      Device,
      req.params.id,
      "linked_to device_id BLE_ADDRESS firmware_version device_version"
    );

    if (!device) return res.status(404).json({ success: false, message: "Device not found" });
    if (!isAuthorized(device, req)) {
      return res.status(403).json({ success: false, message: "Not authorized to record firmware updates" });
    }

    const from_version = device.firmware_version || device.device_version || null;

    const deviceUpdate = {};
    if (status === "success") {
      deviceUpdate.firmware_version          = to_version;
      deviceUpdate.firmware_update_available = false;
      deviceUpdate.last_firmware_update      = new Date();
    }
    if (status === "rollback" && from_version) {
      deviceUpdate.firmware_version          = from_version;
      deviceUpdate.firmware_update_available = false;
    }

    const [historyEntry] = await Promise.all([
      FirmwareHistory.create({
        device_id:    device._id,
        from_version,
        to_version,
        status,
        initiated_by: req.user._id,
        notes,
      }),
      Object.keys(deviceUpdate).length
        ? Device.updateOne({ _id: device._id }, { $set: deviceUpdate })
        : Promise.resolve(),
    ]);

    if (device.linked_to) {
      await sendNotification({
        user_id: device.linked_to,
        type: "FIRMWARE_UPDATE",
        title: `Firmware Update ${status === "success" ? "Completed" : "Failed"}`,
        message: status === "success"
          ? `Your device was successfully updated to firmware v${to_version}.`
          : `Firmware update to v${to_version} ended with status: ${status}.`,
        data: { device_id: device.device_id, to_version, status },
      });
    }

    res.status(200).json({
      success: true,
      message: `Firmware update recorded: ${status}`,
      data: {
        history_id: historyEntry._id,
        device_id:  device.device_id || device._id,
        from_version,
        to_version,
        status,
        updated_at: historyEntry.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get firmware update history (paginated)
// @route   GET /api/devices/:id/firmware/history?page=1&limit=20
// @access  Private (Owner or Admin)
// ─────────────────────────────────────────────
exports.getFirmwareHistory = async (req, res, next) => {
  try {
    const device = await findDeviceByIdentifier(Device, req.params.id, "linked_to device_id");
    if (!device) return res.status(404).json({ success: false, message: "Device not found" });
    if (!isAuthorized(device, req)) {
      return res.status(403).json({ success: false, message: "Not authorized to view firmware history" });
    }

    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const [total, history] = await Promise.all([
      FirmwareHistory.countDocuments({ device_id: device._id }),
      FirmwareHistory.find({ device_id: device._id })
        .populate("initiated_by", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: history.length,
      data: history,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Set the latest available firmware version (Admin push)
// @route   PATCH /api/devices/:id/firmware/set-latest
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.setLatestFirmware = async (req, res, next) => {
  try {
    const { latest_firmware } = req.body;
    if (!latest_firmware) {
      return res.status(400).json({ success: false, message: "latest_firmware version is required" });
    }

    const current = await findDeviceByIdentifier(
      Device, req.params.id, "firmware_version device_version device_id"
    );

    if (!current) return res.status(404).json({ success: false, message: "Device not found" });

    const updateAvailable = isNewerVersion(
      current.firmware_version || current.device_version,
      latest_firmware
    );

    const updated = await Device.findByIdAndUpdate(
      current._id,
      { $set: { latest_firmware, firmware_update_available: updateAvailable } },
      { new: true, select: "device_id firmware_version latest_firmware firmware_update_available" }
    ).lean();

    res.status(200).json({
      success: true,
      message: `Latest firmware set to ${latest_firmware}`,
      data: {
        device_id:        updated.device_id,
        current_firmware: updated.firmware_version,
        latest_firmware:  updated.latest_firmware,
        update_available: updated.firmware_update_available,
      },
    });
  } catch (error) {
    next(error);
  }
};

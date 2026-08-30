/**
 * admin/firmware.controller.js
 *
 * Optimisation notes:
 *   - createFirmwareRelease: duplicate version check with .exists() before insert
 *   - getFirmwareReleases: lean() + pagination + parallel count+data
 *   - updateFirmwareRelease: atomic findByIdAndUpdate — no fetch+save
 *   - deleteFirmwareRelease: soft delete (is_active=false) to preserve history;
 *     hard delete only allowed via a separate query if no devices reference the version
 */
const FirmwareRelease = require("../../models/FirmwareRelease.model");
const Device          = require("../../models/device.model");
const audit           = require("../../security/auditLogger");

// ─────────────────────────────────────────────
// @desc    Create a new firmware release
// @route   POST /api/admin/firmware
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

    // .exists() — minimal check, returns { _id } or null — cheaper than findOne
    const duplicate = await FirmwareRelease.exists({ version });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Firmware version '${version}' already exists`,
        existing_id: duplicate._id,
      });
    }

    const release = await FirmwareRelease.create({
      version, device_type, min_supported_version,
      release_notes, file_url, checksum,
      channel: channel || "stable",
      released_by: req.user._id,
      release_date: new Date(),
      is_active: true,
    });

    audit.log({
      req, category: "FIRMWARE", action: "FIRMWARE_RELEASE_CREATE", status: "SUCCESS",
      resource_type: "Firmware", resource_id: release._id,
      message: `Firmware release created: v${version} (${channel || "stable"})`,
    });

    res.status(201).json({ success: true, message: "Firmware release created", data: release });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    List firmware releases with filters + pagination
// @route   GET /api/admin/firmware?channel=stable&is_active=true&page=1&limit=20
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getFirmwareReleases = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.channel && ["stable", "beta", "deprecated"].includes(req.query.channel))
      filter.channel = req.query.channel;
    if (req.query.is_active !== undefined)
      filter.is_active = req.query.is_active === "true";
    if (req.query.device_type)
      filter.device_type = new RegExp(req.query.device_type.trim(), "i");

    const [total, releases] = await Promise.all([
      FirmwareRelease.countDocuments(filter),
      FirmwareRelease.find(filter)
        .populate("released_by", "name email")
        .sort({ release_date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      count: releases.length,
      data: releases,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update a firmware release
// @route   PUT /api/admin/firmware/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.updateFirmwareRelease = async (req, res, next) => {
  try {
    const allowed = {};
    const { release_notes, file_url, checksum, channel, is_active, min_supported_version } = req.body;
    if (release_notes       !== undefined) allowed.release_notes       = release_notes;
    if (file_url            !== undefined) allowed.file_url            = file_url;
    if (checksum            !== undefined) allowed.checksum            = checksum;
    if (channel             !== undefined) allowed.channel             = channel;
    if (is_active           !== undefined) allowed.is_active           = is_active;
    if (min_supported_version !== undefined) allowed.min_supported_version = min_supported_version;

    // Changing `version` is intentionally disallowed — it's a natural key

    if (!Object.keys(allowed).length) {
      return res.status(400).json({ success: false, message: "No updatable fields provided" });
    }

    const release = await FirmwareRelease.findByIdAndUpdate(
      req.params.id,
      { $set: allowed },
      { new: true, runValidators: true }
    ).lean();

    if (!release) return res.status(404).json({ success: false, message: "Firmware release not found" });

    audit.log({
      req, category: "FIRMWARE", action: "FIRMWARE_RELEASE_UPDATE", status: "SUCCESS",
      resource_type: "Firmware", resource_id: release._id,
      message: `Firmware release updated: v${release.version}`,
      metadata: allowed,
    });

    res.status(200).json({ success: true, message: "Firmware release updated", data: release });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Deprecate / soft-delete a firmware release
// @route   DELETE /api/admin/firmware/:id
// @access  Private/Admin
// Note: Soft-deletes by setting channel='deprecated' and is_active=false.
//       Hard delete blocked if any device still references this version.
// ─────────────────────────────────────────────
exports.deleteFirmwareRelease = async (req, res, next) => {
  try {
    const release = await FirmwareRelease.findById(req.params.id)
      .select("_id version is_active channel")
      .lean();

    if (!release) return res.status(404).json({ success: false, message: "Firmware release not found" });

    /**
     * Safety check: are any devices still on this version?
     * Uses .exists() — stops at the first match, no full scan.
     */
    const deviceOnVersion = await Device.exists({ firmware_version: release.version });
    if (deviceOnVersion) {
      // Soft-delete: mark as deprecated rather than destroying the record
      await FirmwareRelease.updateOne(
        { _id: release._id },
        { $set: { is_active: false, channel: "deprecated" } }
      );
      return res.status(200).json({
        success: true,
        message: `Firmware v${release.version} deprecated (${deviceOnVersion._id ? "devices still on this version" : ""})`,
      });
    }

    // Safe to hard-delete — no devices reference this version
    await FirmwareRelease.deleteOne({ _id: release._id });

    audit.log({
      req, category: "FIRMWARE", action: "FIRMWARE_RELEASE_DELETE", status: "SUCCESS",
      resource_type: "Firmware", resource_id: release._id,
      message: `Firmware release deleted: v${release.version}`,
    });

    res.status(200).json({ success: true, message: `Firmware release v${release.version} deleted` });
  } catch (error) {
    next(error);
  }
};

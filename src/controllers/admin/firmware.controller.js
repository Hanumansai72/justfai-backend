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
const FirmwareRelease  = require("../../models/FirmwareRelease.model");
const Device           = require("../../models/device.model");
const audit            = require("../../security/auditLogger");
const cloudflareR2     = require("../../services/cloudflareR2.service");
const releaseNotifier  = require("../../services/releaseNotification.service");

// ─────────────────────────────────────────────
// @desc    Create a new firmware release (supports direct binary file upload to R2)
// @route   POST /api/admin/firmware
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.createFirmwareRelease = async (req, res, next) => {
  try {
    const {
      version, device_type, min_supported_version,
      release_notes, channel,
    } = req.body;

    let { file_url, checksum } = req.body;

    if (!version) {
      return res.status(400).json({ success: false, message: "version is required" });
    }

    const cleanVersion = version.trim().replace(/^v/i, "");

    // 1. Duplicate check
    const duplicate = await FirmwareRelease.exists({ version: cleanVersion });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `Firmware version '${cleanVersion}' already exists`,
        existing_id: duplicate._id,
      });
    }

    // 2. If a physical .bin file was uploaded in the request, stream to Cloudflare R2
    if (req.file) {
      const fileName = `firmware/v${cleanVersion}-${(device_type || "justride").toLowerCase().replace(/\s+/g, "_")}.bin`;
      const uploadRes = await cloudflareR2.uploadFirmware(req.file.buffer, fileName);
      file_url = uploadRes.url;
      checksum = uploadRes.sha256;
    }

    if (!file_url) {
      return res.status(400).json({ success: false, message: "A .bin file or file_url is required" });
    }

    const release = await FirmwareRelease.create({
      version: cleanVersion,
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

    audit.log({
      req, category: "FIRMWARE", action: "FIRMWARE_RELEASE_CREATE", status: "SUCCESS",
      resource_type: "Firmware", resource_id: release._id,
      message: `Firmware release created: v${cleanVersion} (${channel || "stable"}) -> Cloudflare R2`,
    });

    // Broadcast update notification asynchronously to all paired device owners
    releaseNotifier.notifyFirmwareRelease(release).catch((err) => {
      console.warn("[FirmwareRelease] Notification dispatch error:", err.message);
    });

    res.status(201).json({ success: true, message: "Firmware release published successfully to Cloudflare R2", data: release });
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

// ─────────────────────────────────────────────
// @desc    Set a firmware release as Featured / Active for website & mobile OTA
// @route   PATCH /api/admin/firmware/:id/feature
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.selectFeaturedFirmware = async (req, res, next) => {
  try {
    const release = await FirmwareRelease.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ success: false, message: "Firmware release not found" });
    }

    // Unset other featured releases
    await FirmwareRelease.updateMany(
      { _id: { $ne: release._id } },
      { $set: { is_featured: false } }
    );

    release.is_featured = true;
    release.is_active = true;
    await release.save();

    // Broadcast update notification asynchronously to all paired device owners
    releaseNotifier.notifyFirmwareRelease(release).catch((err) => {
      console.warn("[FirmwareRelease] Notification dispatch error:", err.message);
    });

    res.status(200).json({
      success: true,
      message: `Firmware release v${release.version} is now the active Featured release across Website and Mobile App!`,
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Public endpoint to get latest active/featured firmware for website showcase & OTA
// @route   GET /api/firmware/latest
// @access  Public
// ─────────────────────────────────────────────
exports.getLatestPublicFirmware = async (req, res, next) => {
  try {
    // 1. Check if admin explicitly marked one as featured
    let latest = await FirmwareRelease.findOne({ is_featured: true, is_active: true }).lean();

    // 2. Fall back to newest stable
    if (!latest) {
      latest = await FirmwareRelease.findOne({ is_active: true, channel: "stable" })
        .sort({ release_date: -1 })
        .lean();
    }

    if (!latest) {
      return res.status(200).json({
        success: true,
        data: {
          version: "2.5.4",
          channel: "stable",
          release_notes: "20% Faster Roundabout calculation • Improved Sunlight Auto-dim curve",
        },
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: latest._id,
        version: latest.version,
        channel: latest.channel,
        device_type: latest.device_type,
        release_notes: latest.release_notes,
        file_url: latest.file_url,
        checksum: latest.checksum,
        is_featured: !!latest.is_featured,
        release_date: latest.release_date,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * controllers/admin/appRelease.controller.js
 * Comprehensive Mobile App APK Release Management on Cloudflare R2
 */
const AppRelease   = require("../../models/AppRelease.model");
const audit        = require("../../security/auditLogger");
const cloudflareR2 = require("../../services/cloudflareR2.service");

// ─────────────────────────────────────────────
// @desc    Get Presigned URL to upload APK directly to Cloudflare R2 (Bypasses Vercel 4.5MB payload limit)
// @route   POST /api/admin/app-releases/upload-url
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.getUploadUrl = async (req, res, next) => {
  try {
    const { filename, content_type } = req.body;
    if (!filename) {
      return res.status(400).json({ success: false, message: "filename is required" });
    }

    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const r2Key = `apk/${Date.now()}-${cleanFilename}`;
    const contentType = content_type || "application/vnd.android.package-archive";

    const presigned = await cloudflareR2.getUploadPresignedUrl(r2Key, contentType);

    res.status(200).json({
      success: true,
      data: presigned,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Upload APK and publish new mobile app release
// @route   POST /api/admin/app-releases
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.createAppRelease = async (req, res, next) => {
  try {
    const {
      version,
      build_number,
      platform = "android",
      channel = "stable",
      min_supported_version,
      is_mandatory = false,
      release_notes = "",
    } = req.body;

    let { file_url, checksum_sha256, file_size_bytes } = req.body;

    if (!version || !build_number) {
      return res.status(400).json({
        success: false,
        message: "Version and build_number are required",
      });
    }

    const cleanVersion = version.trim().replace(/^v/i, "");

    // 1. Check duplicate version
    const duplicate = await AppRelease.exists({
      version: cleanVersion,
      platform,
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: `App release v${cleanVersion} for ${platform} already exists`,
      });
    }

    // 2. Upload file to Cloudflare R2 if present
    if (req.file) {
      const fileName = `apk/justride-v${cleanVersion}-b${build_number}-${channel}.apk`;
      const uploadRes = await cloudflareR2.uploadApk(req.file.buffer, fileName);
      file_url = uploadRes.url;
      checksum_sha256 = uploadRes.sha256;
      file_size_bytes = uploadRes.size;
    }

    if (!file_url) {
      return res.status(400).json({
        success: false,
        message: "An APK file or direct file_url is required",
      });
    }

    const release = await AppRelease.create({
      version: cleanVersion,
      build_number: Number(build_number),
      platform,
      channel,
      min_supported_version,
      is_mandatory: is_mandatory === true || is_mandatory === "true",
      release_notes,
      file_url,
      file_size_bytes: file_size_bytes || 0,
      checksum_sha256,
      released_by: req.user._id,
      release_date: new Date(),
      is_active: true,
    });

    audit.log({
      req,
      category: "SYSTEM",
      action: "APP_RELEASE_CREATE",
      status: "SUCCESS",
      resource_type: "AppRelease",
      resource_id: release._id,
      message: `App APK release created: v${cleanVersion} (b${build_number}) -> Cloudflare R2`,
    });

    res.status(201).json({
      success: true,
      message: "App release published successfully to Cloudflare R2",
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    List all app releases with pagination & filtering
// @route   GET /api/admin/app-releases
// @access  Private/Admin or Helper
// ─────────────────────────────────────────────
exports.getAppReleases = async (req, res, next) => {
  try {
    const { platform, channel, is_active, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (platform) filter.platform = platform;
    if (channel) filter.channel = channel;
    if (is_active !== undefined) filter.is_active = is_active === "true";

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

    const [total, releases] = await Promise.all([
      AppRelease.countDocuments(filter),
      AppRelease.find(filter)
        .populate("released_by", "full_name email")
        .sort({ build_number: -1, release_date: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
      data: releases,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Update an existing app release (toggle active / mandatory / notes)
// @route   PUT /api/admin/app-releases/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.updateAppRelease = async (req, res, next) => {
  try {
    const { is_active, is_mandatory, release_notes, min_supported_version, channel } = req.body;

    const release = await AppRelease.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...(is_active !== undefined && { is_active }),
          ...(is_mandatory !== undefined && { is_mandatory }),
          ...(release_notes !== undefined && { release_notes }),
          ...(min_supported_version !== undefined && { min_supported_version }),
          ...(channel !== undefined && { channel }),
        },
      },
      { new: true, runValidators: true }
    );

    if (!release) {
      return res.status(404).json({ success: false, message: "App release not found" });
    }

    res.status(200).json({
      success: true,
      message: "App release updated",
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Delete app release
// @route   DELETE /api/admin/app-releases/:id
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.deleteAppRelease = async (req, res, next) => {
  try {
    const release = await AppRelease.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ success: false, message: "App release not found" });
    }

    await AppRelease.deleteOne({ _id: release._id });

    audit.log({
      req,
      category: "SYSTEM",
      action: "APP_RELEASE_DELETE",
      status: "SUCCESS",
      resource_type: "AppRelease",
      resource_id: release._id,
      message: `App release v${release.version} (b${release.build_number}) deleted`,
    });

    res.status(200).json({ success: true, message: "App release deleted" });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// @desc    Set an app release as the Featured release shown on website and app
// @route   PATCH /api/admin/app-releases/:id/feature
// @access  Private/Admin
// ─────────────────────────────────────────────
exports.selectFeaturedRelease = async (req, res, next) => {
  try {
    const release = await AppRelease.findById(req.params.id);
    if (!release) {
      return res.status(404).json({ success: false, message: "App release not found" });
    }

    // Unset any existing featured release for this platform
    await AppRelease.updateMany(
      { platform: release.platform, _id: { $ne: release._id } },
      { $set: { is_featured: false } }
    );

    release.is_featured = true;
    release.is_active = true;
    await release.save();

    res.status(200).json({
      success: true,
      message: `App release v${release.version} (Build #${release.build_number}) is now set as the Featured release for ${release.platform}!`,
      data: release,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Public / Mobile App endpoint to check latest APK update (prioritizes is_featured release)
// @route   GET /api/app-releases/latest?platform=android&current_build=1
// @access  Public
// ─────────────────────────────────────────────
exports.getLatestAppUpdate = async (req, res, next) => {
  try {
    const { platform = "android", channel, current_build } = req.query;

    // 1. Check if admin explicitly selected a featured release
    let latest = await AppRelease.findOne({
      platform,
      is_featured: true,
      is_active: true,
    }).lean();

    // 2. If no featured flag set, fall back to highest build number
    if (!latest) {
      const filter = { platform, is_active: true };
      if (channel) filter.channel = channel;

      latest = await AppRelease.findOne(filter)
        .sort({ build_number: -1 })
        .lean();
    }

    if (!latest) {
      return res.status(200).json({
        success: true,
        update_available: false,
        message: "No active release found",
      });
    }

    const currentB = Number(current_build) || 0;
    const updateAvailable = latest.build_number > currentB;

    res.status(200).json({
      success: true,
      update_available: updateAvailable,
      data: {
        id: latest._id,
        version: latest.version,
        build_number: latest.build_number,
        platform: latest.platform,
        channel: latest.channel,
        is_mandatory: latest.is_mandatory,
        is_featured: !!latest.is_featured,
        release_notes: latest.release_notes,
        download_url: latest.file_url,
        file_size_bytes: latest.file_size_bytes,
        checksum_sha256: latest.checksum_sha256,
        release_date: latest.release_date,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * controllers/upload.controller.js
 * Image Upload and Preview Controller with Cloudinary.
 *
 * Endpoints:
 *   - POST /api/upload/avatar    → Upload & update user profile picture (240x240 face-centered)
 *   - POST /api/upload/image     → Upload any image & receive 240x240 optimized URL + metadata
 *   - GET  /api/upload/preview/:public_id → Generate custom transformed preview URL on-the-fly
 */
const cloudinaryService = require("../services/cloudinary.service");
const User              = require("../models/User");
const audit             = require("../security/auditLogger");

// ─────────────────────────────────────────────
// @desc    Upload user profile avatar (240x240 face-centered)
// @route   POST /api/upload/avatar
// @access  Private
// ─────────────────────────────────────────────
exports.uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload an image file (field name: 'image' or 'avatar')",
      });
    }

    // Upload to Cloudinary with smart face-centered 240x240 crop & high-fidelity quality
    const uploadResult = await cloudinaryService.uploadImage(req.file.buffer, {
      folder:  `justride/users/${req.user._id}/avatars`,
      width:   240,
      height:  240,
      gravity: "face", // Prioritizes human face detection in avatar photos
    });

    // Update user profile in database with the new avatar URL
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { avatar: uploadResult.secure_url } },
      { new: true, select: "name email avatar" }
    ).lean();

    audit.log({
      req,
      category: "AUTH",
      action: "AVATAR_UPDATE",
      status: "SUCCESS",
      resource_type: "User",
      resource_id: req.user._id,
      message: `User ${req.user.email} updated profile avatar`,
      metadata: { public_id: uploadResult.public_id, url: uploadResult.secure_url },
    });

    res.status(200).json({
      success: true,
      message: "Profile avatar uploaded and resized to 240x240 successfully",
      avatar: uploadResult.secure_url,
      preview: uploadResult.preview_240,
      data: {
        user: updatedUser,
        image: {
          public_id:  uploadResult.public_id,
          secure_url: uploadResult.secure_url,
          width:      uploadResult.width,
          height:     uploadResult.height,
          format:     uploadResult.format,
          bytes:      uploadResult.bytes,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Upload generic image (240x240 smart content crop)
// @route   POST /api/upload/image
// @access  Private
// ─────────────────────────────────────────────
exports.uploadImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload an image file (field name: 'image')",
      });
    }

    const { width = 240, height = 240 } = req.body;
    const imageWidth = Number(width), imageHeight = Number(height);
    if (![imageWidth, imageHeight].every(value => Number.isInteger(value) && value >= 1 && value <= 1024)) {
      return res.status(400).json({ success: false, message: 'Image dimensions must be between 1 and 1024 pixels' });
    }

    const uploadResult = await cloudinaryService.uploadImage(req.file.buffer, {
      folder: `justride/users/${req.user._id}/display`,
      width: imageWidth,
      height: imageHeight,
      gravity: "auto", // Automatically detects the main subject of interest
    });

    res.status(200).json({
      success: true,
      message: "Image uploaded and resized to 240x240 without quality loss",
      url: uploadResult.secure_url,
      preview_240: uploadResult.preview_240,
      data: {
        public_id:  uploadResult.public_id,
        secure_url: uploadResult.secure_url,
        width:      uploadResult.width,
        height:     uploadResult.height,
        format:     uploadResult.format,
        bytes:      uploadResult.bytes,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Get dynamic preview URL for an existing Cloudinary image
// @route   GET /api/upload/preview/:public_id
// @access  Private
// ─────────────────────────────────────────────
exports.getImagePreview = async (req, res, next) => {
  try {
    const publicId = req.params.public_id || req.query.public_id;
    const dimension = value => Math.max(1, Math.min(1024, Number.parseInt(value, 10) || 240));
    const width = dimension(req.query.width), height = dimension(req.query.height);
    const crop = ['fill', 'fit', 'limit', 'scale', 'thumb', 'pad'].includes(req.query.crop) ? req.query.crop : 'fill';
    const gravity = ['auto', 'face', 'faces', 'center'].includes(req.query.gravity) ? req.query.gravity : 'auto';
    if (typeof publicId !== 'string' || !publicId || publicId.length > 1000) {
      return res.status(400).json({ success: false, message: 'Valid public_id is required.' });
    }

    const previewUrl = cloudinaryService.getPreviewUrl(publicId, {
      width,
      height,
      crop,
      gravity,
    });

    res.status(200).json({
      success: true,
      public_id: publicId,
      dimensions: `${width}x${height}`,
      preview_url: previewUrl,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────
// @desc    Delete custom display / uploaded image from Cloudinary
// @route   DELETE /api/upload/image
// @access  Private
// ─────────────────────────────────────────────
exports.deleteImage = async (req, res, next) => {
  try {
    const { public_id, url } = req.body || {};
    let targetPublicId = public_id;
    if (!targetPublicId && url && typeof url === "string") {
      const match = url.match(/upload\/(?:v\d+\/)?([^\.]+)/);
      if (match) targetPublicId = match[1];
    }

    if (!targetPublicId || typeof targetPublicId !== 'string') {
      return res.status(400).json({ success: false, message: 'Image identifier is required' });
    }
    const prefix = 'justride/users/' + req.user._id + '/';
    if (!targetPublicId.startsWith(prefix) || !/^[a-zA-Z0-9_/-]+$/.test(targetPublicId)) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this image' });
    }
    const deleted = await cloudinaryService.deleteImage(targetPublicId);
    if (!deleted || !['ok', 'not found'].includes(deleted.result)) {
      return res.status(503).json({ success: false, message: 'Image deletion could not be confirmed. Please try again.' });
    }

    res.status(200).json({
      success: true,
      message: "Custom display image removed from cloud storage",
    });
  } catch (error) {
    next(error);
  }
};

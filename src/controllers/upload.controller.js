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
      folder:  "justride/avatars",
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

    const { folder = "justride/general", width = 240, height = 240 } = req.body;

    const uploadResult = await cloudinaryService.uploadImage(req.file.buffer, {
      folder,
      width:   parseInt(width, 10) || 240,
      height:  parseInt(height, 10) || 240,
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
    const width    = parseInt(req.query.width, 10) || 240;
    const height   = parseInt(req.query.height, 10) || 240;
    const crop     = req.query.crop || "fill";
    const gravity  = req.query.gravity || "auto";

    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: "public_id parameter is required",
      });
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

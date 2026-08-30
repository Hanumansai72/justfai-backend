/**
 * FirmwareRelease.model.js
 * Represents an official firmware version release managed by admins.
 * Devices are checked against this collection during OTA update checks.
 */
const mongoose = require("mongoose");

const firmwareReleaseSchema = new mongoose.Schema(
  {
    version: {
      type: String,
      required: [true, "Firmware version is required"],
      unique: true,
      trim: true,
    },
    // e.g. "JustRide-X1", "JustRide-Pro" — null = applies to all device types
    device_type: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    // Minimum device firmware that can safely upgrade to this release
    min_supported_version: {
      type: String,
      trim: true,
      default: null,
    },
    release_notes: {
      type: String,
      trim: true,
    },
    // Download URL for the firmware binary (S3, CDN, etc.)
    file_url: {
      type: String,
      trim: true,
    },
    // SHA-256 checksum to verify integrity post-download
    checksum: {
      type: String,
      trim: true,
    },
    is_active: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Stable | Beta | Deprecated
    channel: {
      type: String,
      enum: ["stable", "beta", "deprecated"],
      default: "stable",
      index: true,
    },
    released_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    release_date: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Compound: most common list query — active stable releases, newest first
firmwareReleaseSchema.index({ channel: 1, is_active: 1, release_date: -1 });

module.exports = mongoose.model("FirmwareRelease", firmwareReleaseSchema);
